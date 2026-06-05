import { randomUUID } from "node:crypto";
import type { ImapFlow, FetchMessageObject } from "imapflow";
import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/utils/prisma";
import type { ImapPool } from "@/utils/imap/connection";
import {
  groupIntoThreads,
  linkedMessageIds,
  normalizeMessageId,
  parseReferences,
} from "@/utils/imap/thread";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("imap/sync");

interface FolderSyncState {
  highestModSeq?: string;
  highestUid: number;
  uidValidity: string;
}

type FolderStateMap = Record<string, FolderSyncState>;

// One row's worth of mirror data, computed from a fetched message before we
// know its thread assignment.
interface PendingMessage {
  date: Date;
  flagsFlagged: boolean;
  flagsSeen: boolean;
  fromAddr: string;
  hasAttachments: boolean;
  inReplyTo: string | null;
  messageId: string | null;
  references: string | null;
  snippet: string | null;
  subject: string | null;
  uid: number;
}

/**
 * Syncs a single folder into the ImapMessage mirror table.
 *
 * - UIDVALIDITY changed → drop and re-sync the folder.
 * - Otherwise, when the server has CONDSTORE/QRESYNC and we have a stored
 *   MODSEQ, apply a cheap delta over already-synced UIDs: update changed flags
 *   and drop expunged (VANISHED) messages.
 * - New messages (UID greater than the highest seen) are always fetched in full.
 */
export async function syncFolder({
  pool,
  emailAccountId,
  folder,
}: {
  pool: ImapPool;
  emailAccountId: string;
  folder: string;
}): Promise<{ added: number }> {
  return pool.withMailbox(folder, async (client) => {
    const mailbox = client.mailbox;
    const uidValidity = String(mailbox ? mailbox.uidValidity : 0);
    const modSeq = mailbox ? mailbox.highestModseq : undefined;
    const highestModSeq = modSeq ? String(modSeq) : undefined;
    const condstore = client.capabilities.has("CONDSTORE");
    const state = await readFolderState({ emailAccountId, folder });

    let sinceUid = 0;
    if (state && state.uidValidity === uidValidity) {
      sinceUid = state.highestUid;
      const useModSeqDelta = condstore && !!state.highestModSeq;
      if (useModSeqDelta) {
        await applyFlagDelta({
          client,
          emailAccountId,
          folder,
          uidValidity,
          sinceModSeq: state.highestModSeq as string,
          upToUid: state.highestUid,
        });
      }
      await reconcileFolder({
        client,
        emailAccountId,
        folder,
        uidValidity,
        upToUid: state.highestUid,
        // Without a cheap MODSEQ delta, refresh flags during the same UID scan.
        refreshAllFlags: !useModSeqDelta,
      });
    } else if (state) {
      logger.info("UIDVALIDITY changed, full resync of folder", {
        emailAccountId,
        folder,
      });
      await prisma.imapMessage.deleteMany({
        where: { emailAccountId, folder },
      });
    }

    const pending = await fetchPending(client, sinceUid);
    if (pending.length > 0) {
      await persistMessages({ emailAccountId, folder, uidValidity, pending });
    }

    const highestUid = pending.reduce(
      (max, m) => Math.max(max, m.uid),
      sinceUid,
    );
    await writeFolderState({
      emailAccountId,
      folder,
      state: { uidValidity, highestUid, highestModSeq },
    });

    return { added: pending.length };
  });
}

/**
 * CONDSTORE flag delta: re-reads flags only for messages changed since the
 * stored MODSEQ (cheap — the server filters server-side). Bounded to
 * `1:upToUid` so brand-new messages are left to the full fetch path.
 */
async function applyFlagDelta({
  client,
  emailAccountId,
  folder,
  uidValidity,
  sinceModSeq,
  upToUid,
}: {
  client: ImapFlow;
  emailAccountId: string;
  folder: string;
  uidValidity: string;
  sinceModSeq: string;
  upToUid: number;
}): Promise<void> {
  if (upToUid <= 0) return;

  for await (const message of client.fetch(
    `1:${upToUid}`,
    { uid: true, flags: true },
    { uid: true, changedSince: BigInt(sinceModSeq) },
  )) {
    const flags = message.flags ?? new Set<string>();
    await prisma.imapMessage.updateMany({
      where: {
        emailAccountId,
        folder,
        uidValidity: BigInt(uidValidity),
        uid: BigInt(message.uid),
      },
      data: {
        flagsSeen: flags.has("\\Seen"),
        flagsFlagged: flags.has("\\Flagged"),
      },
    });
  }
}

/**
 * Lists current UIDs (uid-only fetch is cheap) and deletes mirror rows whose
 * UID no longer exists on the server. QRESYNC VANISHED would be cheaper but is
 * delivered as a session event our pooled connections do not carry, so we
 * reconcile explicitly. Works on any server.
 *
 * When `refreshAllFlags` is set (no CONDSTORE delta available) it also re-reads
 * flags in the same pass, so flag changes are still reflected — flags are tiny,
 * so this stays cheap.
 */
async function reconcileFolder({
  client,
  emailAccountId,
  folder,
  uidValidity,
  upToUid,
  refreshAllFlags,
}: {
  client: ImapFlow;
  emailAccountId: string;
  folder: string;
  uidValidity: string;
  upToUid: number;
  refreshAllFlags: boolean;
}): Promise<void> {
  if (upToUid <= 0) return;

  const liveUids = new Set<bigint>();
  for await (const message of client.fetch(
    `1:${upToUid}`,
    { uid: true, flags: refreshAllFlags },
    { uid: true },
  )) {
    liveUids.add(BigInt(message.uid));

    if (refreshAllFlags) {
      const flags = message.flags ?? new Set<string>();
      await prisma.imapMessage.updateMany({
        where: {
          emailAccountId,
          folder,
          uidValidity: BigInt(uidValidity),
          uid: BigInt(message.uid),
        },
        data: {
          flagsSeen: flags.has("\\Seen"),
          flagsFlagged: flags.has("\\Flagged"),
        },
      });
    }
  }

  const rows = await prisma.imapMessage.findMany({
    where: { emailAccountId, folder, uidValidity: BigInt(uidValidity) },
    select: { id: true, uid: true },
  });
  const expungedIds = rows
    .filter((row) => !liveUids.has(row.uid))
    .map((row) => row.id);

  if (expungedIds.length > 0) {
    await prisma.imapMessage.deleteMany({ where: { id: { in: expungedIds } } });
  }
}

async function fetchPending(
  client: ImapFlow,
  sinceUid: number,
): Promise<PendingMessage[]> {
  const range = `${sinceUid + 1}:*`;
  const pending: PendingMessage[] = [];

  for await (const message of client.fetch(
    range,
    {
      uid: true,
      flags: true,
      envelope: true,
      bodyStructure: true,
      // ENVELOPE in-reply-to is unreliable across servers; read the headers.
      headers: ["in-reply-to", "references"],
    },
    { uid: true },
  )) {
    // `n:*` always returns at least the last message even when none are newer.
    if (message.uid <= sinceUid) continue;
    pending.push(toPending(message));
  }

  return pending;
}

function toPending(message: FetchMessageObject): PendingMessage {
  const envelope = message.envelope;
  const flags = message.flags ?? new Set<string>();
  const from = envelope?.from?.[0];
  const fromAddr = from ? (from.address ?? from.name ?? "") : "";

  const headers = parseHeaderLines(message.headers);
  const inReplyTo =
    normalizeMessageId(headers["in-reply-to"]) ??
    normalizeMessageId(envelope?.inReplyTo);
  const references = headers.references
    ? parseReferences(headers.references).join(" ") || null
    : inReplyTo;

  return {
    uid: message.uid,
    messageId: normalizeMessageId(envelope?.messageId),
    inReplyTo,
    references,
    fromAddr,
    subject: envelope?.subject ?? null,
    date: envelope?.date ?? new Date(0),
    flagsSeen: flags.has("\\Seen"),
    flagsFlagged: flags.has("\\Flagged"),
    hasAttachments: hasAttachments(message.bodyStructure),
    snippet: null,
  };
}

function parseHeaderLines(
  raw: FetchMessageObject["headers"],
): Record<string, string> {
  if (!raw) return {};
  const text = raw.toString("utf8");
  const result: Record<string, string> = {};
  // Unfold continuation lines, then split into "name: value" pairs.
  for (const line of text.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (match) result[match[1].toLowerCase()] = match[2].trim();
  }
  return result;
}

async function persistMessages({
  emailAccountId,
  folder,
  uidValidity,
  pending,
}: {
  emailAccountId: string;
  folder: string;
  uidValidity: string;
  pending: PendingMessage[];
}): Promise<void> {
  const threadIds = await assignThreadIds({ emailAccountId, pending });

  for (let i = 0; i < pending.length; i++) {
    const m = pending[i];
    await prisma.imapMessage.upsert({
      where: {
        emailAccountId_folder_uidValidity_uid: {
          emailAccountId,
          folder,
          uidValidity: BigInt(uidValidity),
          uid: BigInt(m.uid),
        },
      },
      create: {
        emailAccountId,
        folder,
        uidValidity: BigInt(uidValidity),
        uid: BigInt(m.uid),
        threadId: threadIds[i],
        messageIdHdr: m.messageId,
        inReplyTo: m.inReplyTo,
        references: m.references,
        fromAddr: m.fromAddr,
        subject: m.subject,
        date: m.date,
        flagsSeen: m.flagsSeen,
        flagsFlagged: m.flagsFlagged,
        hasAttachments: m.hasAttachments,
        snippet: m.snippet,
      },
      update: {
        flagsSeen: m.flagsSeen,
        flagsFlagged: m.flagsFlagged,
      },
    });
  }
}

/**
 * Assigns a threadId to each pending message: reuse an existing thread when the
 * message links (via message-id/in-reply-to/references) to one already stored,
 * otherwise group the new batch among itself and mint a fresh threadId.
 */
async function assignThreadIds({
  emailAccountId,
  pending,
}: {
  emailAccountId: string;
  pending: PendingMessage[];
}): Promise<string[]> {
  const allLinkedIds = new Set<string>();
  for (const m of pending) {
    for (const id of linkedMessageIds(m)) allLinkedIds.add(id);
  }

  const existing = allLinkedIds.size
    ? await prisma.imapMessage.findMany({
        where: {
          emailAccountId,
          messageIdHdr: { in: [...allLinkedIds] },
        },
        select: { messageIdHdr: true, threadId: true },
      })
    : [];

  const knownThreadByMessageId = new Map<string, string>();
  for (const row of existing) {
    if (row.messageIdHdr)
      knownThreadByMessageId.set(row.messageIdHdr, row.threadId);
  }

  const result: string[] = new Array(pending.length);
  for (const group of groupIntoThreads(pending)) {
    const existingThreadId = findExistingThreadId(
      group,
      pending,
      knownThreadByMessageId,
    );
    const threadId = existingThreadId ?? randomUUID();
    for (const index of group) result[index] = threadId;
  }

  return result;
}

function findExistingThreadId(
  group: number[],
  pending: PendingMessage[],
  knownThreadByMessageId: Map<string, string>,
): string | undefined {
  for (const index of group) {
    for (const id of linkedMessageIds(pending[index])) {
      const threadId = knownThreadByMessageId.get(id);
      if (threadId) return threadId;
    }
  }
  return;
}

function hasAttachments(
  structure: FetchMessageObject["bodyStructure"],
): boolean {
  if (!structure) return false;
  const stack = [structure];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.disposition === "attachment") return true;
    if (node.childNodes) stack.push(...node.childNodes);
  }
  return false;
}

async function readFolderState({
  emailAccountId,
  folder,
}: {
  emailAccountId: string;
  folder: string;
}): Promise<FolderSyncState | null> {
  const account = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: { imapFolderState: true },
  });
  const map = (account?.imapFolderState as FolderStateMap | null) ?? {};
  return map[folder] ?? null;
}

async function writeFolderState({
  emailAccountId,
  folder,
  state,
}: {
  emailAccountId: string;
  folder: string;
  state: FolderSyncState;
}): Promise<void> {
  const account = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: { imapFolderState: true },
  });
  const map = (account?.imapFolderState as FolderStateMap | null) ?? {};
  map[folder] = state;
  await prisma.emailAccount.update({
    where: { id: emailAccountId },
    data: { imapFolderState: map as unknown as Prisma.InputJsonValue },
  });
}

export { parseReferences };
