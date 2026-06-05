import { randomUUID } from "node:crypto";
import type Mail from "nodemailer/lib/mailer";
import type { ImapMessage, Prisma } from "@/generated/prisma/client";
import prisma from "@/utils/prisma";
import type {
  EmailFilter,
  EmailLabel,
  EmailProvider,
  EmailSignature,
  EmailThread,
  SentMessagePage,
} from "@/utils/email/types";
import type { OutlookFolder } from "@/utils/outlook/folders";
import type { ParsedMessage } from "@/utils/types";
import type { InboxZeroLabel } from "@/utils/label";
import { inboxZeroLabels } from "@/utils/label";
import type { ThreadsQuery } from "@/utils/threads/validation";
import { buildThreadingHeaders } from "@/utils/email/threading";
import { convertEmailHtmlToText } from "@/utils/mail";
import type { Logger } from "@/utils/logger";
import { getImapPoolForEmail, type ImapPool } from "@/utils/imap/connection";
import {
  detectCapabilities,
  resolveSpecialFolders,
  type ImapCapabilities,
  type SpecialFolders,
} from "@/utils/imap/capabilities";
import { toParsedMessage } from "@/utils/imap/parse";
import { buildMime, getSmtpConfig, sendViaSmtp } from "@/utils/imap/send";
import { buildWhere, parseQuery } from "@/utils/imap/query";
import { syncFolder } from "@/utils/imap/sync";
import { normalizeMessageId } from "@/utils/imap/thread";

type MailAttachment = NonNullable<Mail.Options["attachments"]>[number];

/**
 * IMAP/SMTP implementation of EmailProvider.
 *
 * Design decisions baked in:
 * - Messages get a stable app-facing id from the ImapMessage mirror table (id
 *   survives folder MOVEs, which change the underlying UID).
 * - "Labels" map to IMAP folders: applying a label moves the message, so a
 *   message has at most one label and labeling removes it from the inbox.
 * - Targets max compatibility: capability detection with fallbacks (MOVE,
 *   THREAD, CONDSTORE, IDLE) and SPECIAL-USE folder resolution with name hints.
 */
export class ImapProvider implements EmailProvider {
  readonly name = "imap" as const;
  private readonly pool: ImapPool;
  private readonly emailAccountId: string;
  private readonly emailAddress: string;
  private readonly special: SpecialFolders;
  private readonly capabilities: ImapCapabilities;
  private readonly logger: Logger;

  constructor(args: {
    pool: ImapPool;
    emailAccountId: string;
    emailAddress: string;
    special: SpecialFolders;
    capabilities: ImapCapabilities;
    logger: Logger;
  }) {
    this.pool = args.pool;
    this.emailAccountId = args.emailAccountId;
    this.emailAddress = args.emailAddress;
    this.special = args.special;
    this.capabilities = args.capabilities;
    this.logger = args.logger;
  }

  static async create({
    emailAccountId,
    logger,
  }: {
    emailAccountId: string;
    logger: Logger;
  }): Promise<ImapProvider> {
    const pool = await getImapPoolForEmail({ emailAccountId });
    const account = await prisma.emailAccount.findUnique({
      where: { id: emailAccountId },
      select: { email: true, imapSpecialFolders: true },
    });
    const override =
      (account?.imapSpecialFolders as
        | Partial<Record<string, string>>
        | null
        | undefined) ?? undefined;
    const [special, capabilities] = await Promise.all([
      resolveSpecialFolders(pool, override),
      detectCapabilities(pool),
    ]);
    return new ImapProvider({
      pool,
      emailAccountId,
      emailAddress: account?.email ?? "",
      special,
      capabilities,
      logger,
    });
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  async getMessage(messageId: string): Promise<ParsedMessage> {
    const row = await this.getRowById(messageId);
    return this.toMessage(row);
  }

  async getMessagesBatch(messageIds: string[]): Promise<ParsedMessage[]> {
    const rows = await prisma.imapMessage.findMany({
      where: { emailAccountId: this.emailAccountId, id: { in: messageIds } },
    });
    return this.toMessages(rows);
  }

  async getThread(threadId: string): Promise<EmailThread> {
    const rows = await this.getThreadRows(threadId);
    const messages = await this.toMessages(rows);
    return {
      id: threadId,
      messages,
      snippet: messages.at(-1)?.snippet ?? "",
    };
  }

  async getThreadMessages(threadId: string): Promise<ParsedMessage[]> {
    return this.toMessages(await this.getThreadRows(threadId));
  }

  async getThreadMessagesInInbox(threadId: string): Promise<ParsedMessage[]> {
    const rows = await prisma.imapMessage.findMany({
      where: {
        emailAccountId: this.emailAccountId,
        threadId,
        folder: this.special.inbox,
      },
      orderBy: { date: "asc" },
    });
    return this.toMessages(rows);
  }

  async getThreads(folderId?: string): Promise<EmailThread[]> {
    const folder = folderId ?? this.special.inbox;
    const rows = await prisma.imapMessage.findMany({
      where: { emailAccountId: this.emailAccountId, folder },
      orderBy: { date: "desc" },
      take: 200,
    });
    return this.threadsFromRows(rows);
  }

  async getInboxMessages(maxResults = 50): Promise<ParsedMessage[]> {
    const rows = await prisma.imapMessage.findMany({
      where: {
        emailAccountId: this.emailAccountId,
        folder: this.special.inbox,
      },
      orderBy: { date: "desc" },
      take: maxResults,
    });
    return this.toMessages(rows);
  }

  async getLatestMessageInThread(
    threadId: string,
  ): Promise<ParsedMessage | null> {
    const row = await prisma.imapMessage.findFirst({
      where: { emailAccountId: this.emailAccountId, threadId },
      orderBy: { date: "desc" },
    });
    return row ? this.toMessage(row) : null;
  }

  async getLatestMessageFromThreadSnapshot(
    thread: Pick<EmailThread, "id" | "messages">,
  ): Promise<ParsedMessage | null> {
    return thread.messages.at(-1) ?? null;
  }

  async getMessageByRfc822MessageId(
    rfc822MessageId: string,
  ): Promise<ParsedMessage | null> {
    const normalized = normalizeMessageId(rfc822MessageId);
    if (!normalized) return null;
    const row = await prisma.imapMessage.findFirst({
      where: {
        emailAccountId: this.emailAccountId,
        messageIdHdr: normalized,
      },
    });
    return row ? this.toMessage(row) : null;
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ data: string; size: number }> {
    const message = await this.getMessage(messageId);
    const all = [...(message.attachments ?? []), ...message.inline];
    const match = all.find((a) => a.attachmentId === attachmentId);
    if (!match) throw new Error("Attachment not found");
    // We re-fetch and re-parse to obtain the binary content.
    const row = await this.getRowById(messageId);
    const raw = await this.fetchSource(row);
    const { simpleParser } = await import("mailparser");
    const mail = await simpleParser(raw);
    const att = mail.attachments[Number(attachmentId)];
    if (!att) throw new Error("Attachment content not found");
    return { data: att.content.toString("base64"), size: att.size };
  }

  async getInboxStats(): Promise<{ total: number; unread: number }> {
    const where = {
      emailAccountId: this.emailAccountId,
      folder: this.special.inbox,
    };
    const [total, unread] = await Promise.all([
      prisma.imapMessage.count({ where }),
      prisma.imapMessage.count({ where: { ...where, flagsSeen: false } }),
    ]);
    return { total, unread };
  }

  async getSentMessages(maxResults = 50): Promise<ParsedMessage[]> {
    if (!this.special.sent) return [];
    const rows = await prisma.imapMessage.findMany({
      where: { emailAccountId: this.emailAccountId, folder: this.special.sent },
      orderBy: { date: "desc" },
      take: maxResults,
    });
    return this.toMessages(rows);
  }

  async getSentMessageIds(options: {
    maxResults: number;
    after?: Date;
    before?: Date;
    pageToken?: string;
  }): Promise<SentMessagePage> {
    if (!this.special.sent) return { messages: [] };
    const offset = options.pageToken ? Number(options.pageToken) : 0;
    const rows = await prisma.imapMessage.findMany({
      where: {
        emailAccountId: this.emailAccountId,
        folder: this.special.sent,
        date: dateRange(options.after, options.before),
      },
      orderBy: { date: "desc" },
      skip: offset,
      take: options.maxResults,
    });
    return {
      messages: rows.map((r) => ({ id: r.id, threadId: r.threadId })),
      nextPageToken:
        rows.length === options.maxResults
          ? String(offset + rows.length)
          : undefined,
    };
  }

  async getSentThreadsExcluding(options: {
    excludeToEmails?: string[];
    excludeFromEmails?: string[];
    maxResults?: number;
  }): Promise<EmailThread[]> {
    if (!this.special.sent) return [];
    const rows = await prisma.imapMessage.findMany({
      where: {
        emailAccountId: this.emailAccountId,
        folder: this.special.sent,
        fromAddr: options.excludeFromEmails?.length
          ? { notIn: options.excludeFromEmails }
          : undefined,
      },
      orderBy: { date: "desc" },
      take: options.maxResults ?? 50,
    });
    return this.threadsFromRows(rows);
  }

  async getMessagesFromSender(options: {
    senderEmail: string;
    maxResults?: number;
    pageToken?: string;
    before?: Date;
    after?: Date;
  }): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    const offset = options.pageToken ? Number(options.pageToken) : 0;
    const take = options.maxResults ?? 50;
    const rows = await prisma.imapMessage.findMany({
      where: {
        emailAccountId: this.emailAccountId,
        fromAddr: { contains: options.senderEmail, mode: "insensitive" },
        date: dateRange(options.after, options.before),
      },
      orderBy: { date: "desc" },
      skip: offset,
      take,
    });
    return {
      messages: await this.toMessages(rows),
      nextPageToken:
        rows.length === take ? String(offset + rows.length) : undefined,
    };
  }

  async getThreadsFromSenderWithSubject(
    sender: string,
    limit: number,
  ): Promise<Array<{ id: string; snippet: string; subject: string }>> {
    const rows = await prisma.imapMessage.findMany({
      where: {
        emailAccountId: this.emailAccountId,
        fromAddr: { contains: sender, mode: "insensitive" },
      },
      orderBy: { date: "desc" },
      take: limit,
      distinct: ["threadId"],
    });
    return rows.map((r) => ({
      id: r.threadId,
      snippet: r.snippet ?? "",
      subject: r.subject ?? "",
    }));
  }

  async getThreadsWithParticipant(options: {
    participantEmail: string;
    maxThreads?: number;
  }): Promise<EmailThread[]> {
    // Only the sender is mirrored; to/cc are not, so this matches by sender.
    const rows = await prisma.imapMessage.findMany({
      where: {
        emailAccountId: this.emailAccountId,
        fromAddr: { contains: options.participantEmail, mode: "insensitive" },
      },
      orderBy: { date: "desc" },
      take: options.maxThreads ?? 50,
    });
    return this.threadsFromRows(rows);
  }

  async hasPreviousCommunicationsWithSenderOrDomain(options: {
    from: string;
    date: Date;
    messageId: string;
  }): Promise<boolean> {
    const count = await prisma.imapMessage.count({
      where: {
        emailAccountId: this.emailAccountId,
        fromAddr: { contains: extractEmail(options.from), mode: "insensitive" },
        date: { lt: options.date },
        id: { not: options.messageId },
      },
    });
    return count > 0;
  }

  async checkIfReplySent(senderEmail: string): Promise<boolean> {
    if (!this.special.sent) return false;
    const threads = await prisma.imapMessage.findMany({
      where: {
        emailAccountId: this.emailAccountId,
        fromAddr: { contains: senderEmail, mode: "insensitive" },
      },
      select: { threadId: true },
      take: 50,
    });
    if (!threads.length) return false;
    const sent = await prisma.imapMessage.count({
      where: {
        emailAccountId: this.emailAccountId,
        folder: this.special.sent,
        threadId: { in: threads.map((t) => t.threadId) },
      },
    });
    return sent > 0;
  }

  async countReceivedMessages(
    senderEmail: string,
    threshold: number,
  ): Promise<number> {
    const count = await prisma.imapMessage.count({
      where: {
        emailAccountId: this.emailAccountId,
        fromAddr: { contains: senderEmail, mode: "insensitive" },
      },
    });
    return Math.min(count, threshold);
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  async searchMessages(options: {
    query: string;
    maxResults?: number;
    pageToken?: string;
    readState?: "read" | "unread";
    labelName?: string;
  }): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    const parsed = parseQuery(options.query);
    if (options.readState) parsed.isUnread = options.readState === "unread";
    const folders = options.labelName
      ? [options.labelName]
      : this.searchFolders();
    const where = await this.buildSearchWhere(parsed, folders);
    const folderWhere = options.labelName
      ? { ...where, folder: options.labelName }
      : where;
    return this.pageMessages(
      folderWhere,
      options.maxResults,
      options.pageToken,
    );
  }

  async getMessagesWithPagination(options: {
    query?: string;
    maxResults?: number;
    pageToken?: string;
    before?: Date;
    after?: Date;
    inboxOnly?: boolean;
    unreadOnly?: boolean;
  }): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    const parsed = parseQuery(options.query);
    if (options.after) parsed.after = options.after;
    if (options.before) parsed.before = options.before;
    if (options.unreadOnly) parsed.isUnread = true;
    const folders = options.inboxOnly
      ? [this.special.inbox]
      : this.searchFolders();
    const where = await this.buildSearchWhere(parsed, folders);
    const finalWhere = options.inboxOnly
      ? { ...where, folder: this.special.inbox }
      : where;
    return this.pageMessages(finalWhere, options.maxResults, options.pageToken);
  }

  async getThreadsWithQuery(options: {
    query?: ThreadsQuery;
    maxResults?: number;
    pageToken?: string;
  }): Promise<{ threads: EmailThread[]; nextPageToken?: string }> {
    const q = options.query;
    const take = options.maxResults ?? 50;
    const offset = options.pageToken ? Number(options.pageToken) : 0;
    const rows = await prisma.imapMessage.findMany({
      where: {
        emailAccountId: this.emailAccountId,
        folder: q?.labelId ?? this.special.inbox,
        fromAddr: q?.fromEmail
          ? { contains: q.fromEmail, mode: "insensitive" }
          : undefined,
        flagsSeen: q?.isUnread ? false : undefined,
        date: dateRange(q?.after ?? undefined, q?.before ?? undefined),
      },
      orderBy: { date: "desc" },
      skip: offset,
      take,
    });
    return {
      threads: await this.threadsFromRows(rows),
      nextPageToken:
        rows.length === take ? String(offset + rows.length) : undefined,
    };
  }

  async getMessagesWithAttachments(options: {
    maxResults?: number;
    pageToken?: string;
  }): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    return this.pageMessages(
      { emailAccountId: this.emailAccountId, hasAttachments: true },
      options.maxResults,
      options.pageToken,
    );
  }

  // ---------------------------------------------------------------------------
  // Flags & read state
  // ---------------------------------------------------------------------------

  async markRead(threadId: string): Promise<void> {
    await this.markReadThread(threadId, true);
  }

  async markReadThread(threadId: string, read: boolean): Promise<void> {
    const rows = await this.getThreadRows(threadId);
    await this.setFlag(rows, "\\Seen", read);
    await prisma.imapMessage.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { flagsSeen: read },
    });
  }

  async starMessage(messageId: string): Promise<void> {
    const row = await this.getRowById(messageId);
    await this.setFlag([row], "\\Flagged", true);
    await prisma.imapMessage.update({
      where: { id: row.id },
      data: { flagsFlagged: true },
    });
  }

  // ---------------------------------------------------------------------------
  // Archive / trash / spam / move
  // ---------------------------------------------------------------------------

  async archiveMessage(messageId: string): Promise<void> {
    if (!this.special.archive) return;
    const row = await this.getRowById(messageId);
    await this.moveRows([row], this.special.archive);
  }

  async archiveThread(threadId: string): Promise<void> {
    if (!this.special.archive) return;
    await this.moveRows(
      await this.getThreadRows(threadId),
      this.special.archive,
    );
  }

  async archiveThreadWithLabel(
    threadId: string,
    _ownerEmail: string,
    labelId?: string,
  ): Promise<void> {
    const target = labelId ?? this.special.archive;
    if (!target) return;
    await this.moveRows(await this.getThreadRows(threadId), target);
  }

  async trashThread(threadId: string): Promise<void> {
    if (!this.special.trash) return;
    await this.moveRows(await this.getThreadRows(threadId), this.special.trash);
  }

  async markSpam(threadId: string): Promise<void> {
    if (!this.special.junk) return;
    await this.moveRows(await this.getThreadRows(threadId), this.special.junk);
  }

  async blockUnsubscribedEmail(messageId: string): Promise<void> {
    if (!this.special.junk) return;
    const row = await this.getRowById(messageId);
    await this.moveRows([row], this.special.junk);
  }

  async moveThreadToFolder(
    threadId: string,
    _ownerEmail: string,
    folderName: string,
  ): Promise<void> {
    const target = await this.getOrCreateFolderIdByName(folderName);
    await this.moveRows(await this.getThreadRows(threadId), target);
  }

  async bulkArchiveFromSenders(fromEmails: string[]): Promise<void> {
    if (!this.special.archive) return;
    await this.moveRowsFromSenders(fromEmails, this.special.archive);
  }

  async bulkTrashFromSenders(fromEmails: string[]): Promise<void> {
    if (!this.special.trash) return;
    await this.moveRowsFromSenders(fromEmails, this.special.trash);
  }

  // ---------------------------------------------------------------------------
  // Labels (mapped to folders)
  // ---------------------------------------------------------------------------

  async getLabels(): Promise<EmailLabel[]> {
    const boxes = await this.pool.withConnection((c) => c.list());
    return boxes.map((b) => folderToLabel(b.path));
  }

  async getLabelById(labelId: string): Promise<EmailLabel | null> {
    const labels = await this.getLabels();
    return labels.find((l) => l.id === labelId) ?? null;
  }

  async getLabelByName(name: string): Promise<EmailLabel | null> {
    const labels = await this.getLabels();
    return labels.find((l) => l.name === name) ?? null;
  }

  async createLabel(name: string): Promise<EmailLabel> {
    await this.pool.withConnection((c) => c.mailboxCreate(name));
    return folderToLabel(name);
  }

  async deleteLabel(labelId: string): Promise<void> {
    await this.pool.withConnection((c) => c.mailboxDelete(labelId));
  }

  async labelMessage(options: {
    messageId: string;
    labelId: string;
    labelName: string | null;
  }): Promise<{ usedFallback?: boolean; actualLabelId?: string }> {
    const row = await this.getRowById(options.messageId);
    const target = await this.getOrCreateFolderIdByName(options.labelId);
    await this.moveRows([row], target);
    return { actualLabelId: target };
  }

  async removeThreadLabel(threadId: string, labelId: string): Promise<void> {
    const rows = await prisma.imapMessage.findMany({
      where: {
        emailAccountId: this.emailAccountId,
        threadId,
        folder: labelId,
      },
    });
    await this.moveRows(rows, this.special.inbox);
  }

  async removeThreadLabels(
    threadId: string,
    labelIds: string[],
  ): Promise<void> {
    for (const labelId of labelIds) {
      await this.removeThreadLabel(threadId, labelId);
    }
  }

  async getThreadsWithLabel(options: {
    labelId: string;
    maxResults?: number;
  }): Promise<EmailThread[]> {
    const rows = await prisma.imapMessage.findMany({
      where: { emailAccountId: this.emailAccountId, folder: options.labelId },
      orderBy: { date: "desc" },
      take: options.maxResults ?? 50,
    });
    return this.threadsFromRows(rows);
  }

  async getOrCreateInboxZeroLabel(key: InboxZeroLabel): Promise<EmailLabel> {
    const name = inboxZeroLabels[key].name;
    const path = await this.getOrCreateFolderIdByName(name);
    return folderToLabel(path);
  }

  async getFolders(): Promise<OutlookFolder[]> {
    const boxes = await this.pool.withConnection((c) => c.list());
    return boxes.map((b) => ({
      id: b.path,
      displayName: b.name,
      childFolders: [],
    }));
  }

  async getOrCreateFolderIdByName(folderName: string): Promise<string> {
    const boxes = await this.pool.withConnection((c) => c.list());
    const existing = boxes.find(
      (b) => b.path === folderName || b.name === folderName,
    );
    if (existing) return existing.path;
    const created = await this.pool.withConnection((c) =>
      c.mailboxCreate(folderName),
    );
    return created.path;
  }

  // ---------------------------------------------------------------------------
  // Sending & drafts
  // ---------------------------------------------------------------------------

  async sendEmail(args: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    messageText: string;
    attachments?: MailAttachment[];
  }): Promise<void> {
    await this.send({
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject,
      text: args.messageText,
      attachments: args.attachments,
    });
  }

  async sendEmailWithHtml(body: {
    replyToEmail?: {
      threadId: string;
      headerMessageId: string;
      references?: string;
    };
    to: string;
    from?: string;
    cc?: string;
    bcc?: string;
    replyTo?: string;
    subject: string;
    messageHtml: string;
    attachments?: Array<{
      filename: string;
      content: string;
      contentType: string;
    }>;
  }): Promise<{ messageId: string; threadId: string }> {
    const threading = body.replyToEmail
      ? buildThreadingHeaders({
          headerMessageId: body.replyToEmail.headerMessageId,
          references: body.replyToEmail.references,
        })
      : undefined;

    const result = await this.send({
      to: body.to,
      from: body.from,
      cc: body.cc,
      bcc: body.bcc,
      replyTo: body.replyTo,
      subject: body.subject,
      html: body.messageHtml,
      text: convertEmailHtmlToText({ htmlText: body.messageHtml }),
      inReplyTo: threading?.inReplyTo,
      references: threading?.references,
      attachments: body.attachments?.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content, "base64"),
        contentType: a.contentType,
      })),
    });

    return {
      messageId: result.messageId,
      threadId: body.replyToEmail?.threadId ?? randomUUID(),
    };
  }

  async replyToEmail(
    email: ParsedMessage,
    content: string,
    options?: {
      replyTo?: string;
      from?: string;
      attachments?: MailAttachment[];
    },
  ): Promise<void> {
    const headerMessageId = email.headers["message-id"] ?? "";
    const threading = buildThreadingHeaders({
      headerMessageId,
      references: email.headers.references,
    });
    await this.send({
      to: email.headers["reply-to"] || email.headers.from,
      from: options?.from,
      replyTo: options?.replyTo,
      subject: ensureRePrefix(email.subject),
      html: content,
      text: convertEmailHtmlToText({ htmlText: content }),
      inReplyTo: threading.inReplyTo,
      references: threading.references,
      attachments: options?.attachments,
    });
  }

  async forwardEmail(
    email: ParsedMessage,
    args: {
      to: string;
      cc?: string;
      bcc?: string;
      content?: string;
      from?: string;
    },
  ): Promise<void> {
    const body = `${args.content ?? ""}<br><br>---------- Forwarded message ----------<br>${
      email.textHtml ?? email.textPlain ?? ""
    }`;
    await this.send({
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      from: args.from,
      subject: ensureFwdPrefix(email.subject),
      html: body,
      text: convertEmailHtmlToText({ htmlText: body }),
    });
  }

  async createDraft(params: {
    to: string;
    subject: string;
    messageHtml: string;
    replyToMessageId?: string;
  }): Promise<{ id: string }> {
    return this.appendDraft({
      to: params.to,
      subject: params.subject,
      html: params.messageHtml,
      text: convertEmailHtmlToText({ htmlText: params.messageHtml }),
    });
  }

  async draftEmail(
    email: ParsedMessage,
    args: {
      to?: string;
      subject?: string;
      content: string;
      cc?: string;
      bcc?: string;
      attachments?: MailAttachment[];
    },
  ): Promise<{ draftId: string }> {
    const { id } = await this.appendDraft({
      to: args.to ?? email.headers.from,
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject ?? ensureRePrefix(email.subject),
      html: args.content,
      text: convertEmailHtmlToText({ htmlText: args.content }),
      attachments: args.attachments,
    });
    return { draftId: id };
  }

  async getDraft(draftId: string): Promise<ParsedMessage | null> {
    const row = await prisma.imapMessage.findUnique({ where: { id: draftId } });
    return row ? this.toMessage(row) : null;
  }

  async getDrafts(options?: { maxResults?: number }): Promise<ParsedMessage[]> {
    if (!this.special.drafts) return [];
    const rows = await prisma.imapMessage.findMany({
      where: {
        emailAccountId: this.emailAccountId,
        folder: this.special.drafts,
      },
      orderBy: { date: "desc" },
      take: options?.maxResults ?? 50,
    });
    return this.toMessages(rows);
  }

  async updateDraft(
    draftId: string,
    params: { messageHtml?: string; subject?: string },
  ): Promise<void> {
    const existing = await this.getDraft(draftId);
    if (!existing) throw new Error("Draft not found");
    await this.deleteDraft(draftId);
    await this.appendDraft({
      to: existing.headers.to,
      subject: params.subject ?? existing.subject,
      html: params.messageHtml ?? existing.textHtml ?? "",
      text: convertEmailHtmlToText({
        htmlText: params.messageHtml ?? existing.textHtml ?? "",
      }),
    });
  }

  async deleteDraft(draftId: string): Promise<void> {
    const row = await prisma.imapMessage.findUnique({ where: { id: draftId } });
    if (!row) return;
    await this.pool.withMailbox(row.folder, (c) =>
      c.messageDelete(String(Number(row.uid)), { uid: true }),
    );
    await prisma.imapMessage.delete({ where: { id: row.id } });
  }

  async sendDraft(
    draftId: string,
  ): Promise<{ messageId: string; threadId: string }> {
    const draft = await this.getDraft(draftId);
    if (!draft) throw new Error("Draft not found");
    const result = await this.send({
      to: draft.headers.to,
      cc: draft.headers.cc,
      subject: draft.subject,
      html: draft.textHtml,
      text:
        draft.textPlain ??
        convertEmailHtmlToText({ htmlText: draft.textHtml ?? "" }),
    });
    await this.deleteDraft(draftId);
    return { messageId: result.messageId, threadId: draft.threadId };
  }

  async getSignatures(): Promise<EmailSignature[]> {
    return [];
  }

  // ---------------------------------------------------------------------------
  // Filters — IMAP has no standard server-side filter API.
  // ---------------------------------------------------------------------------

  async getFiltersList(): Promise<EmailFilter[]> {
    return [];
  }

  async createFilter(): Promise<{ status: number }> {
    this.logger.trace("createFilter is a no-op for IMAP");
    return { status: 200 };
  }

  async createAutoArchiveFilter(): Promise<{ status: number }> {
    this.logger.trace("createAutoArchiveFilter is a no-op for IMAP");
    return { status: 200 };
  }

  async deleteFilter(): Promise<{ status: number }> {
    return { status: 200 };
  }

  // ---------------------------------------------------------------------------
  // Watch — no webhooks in IMAP; sync is poll/IDLE driven elsewhere.
  // ---------------------------------------------------------------------------

  async watchEmails(): Promise<{
    expirationDate: Date;
    subscriptionId?: string;
  } | null> {
    return null;
  }

  async unwatchEmails(): Promise<void> {
    // no-op
  }

  // ---------------------------------------------------------------------------
  // Misc
  // ---------------------------------------------------------------------------

  async getOriginalMessage(
    originalMessageId: string | undefined,
  ): Promise<ParsedMessage | null> {
    if (!originalMessageId) return null;
    return this.getMessageByRfc822MessageId(originalMessageId);
  }

  async getPreviousConversationMessages(
    messageIds: string[],
  ): Promise<ParsedMessage[]> {
    return this.getMessagesBatch(messageIds);
  }

  isReplyInThread(message: ParsedMessage): boolean {
    return Boolean(message.headers["in-reply-to"]);
  }

  isSentMessage(message: ParsedMessage): boolean {
    return Boolean(
      this.special.sent && message.parentFolderId === this.special.sent,
    );
  }

  getAccessToken(): string {
    return "";
  }

  toJSON(): { name: string; type: string } {
    return { name: this.name, type: "imap" };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async getRowById(id: string): Promise<ImapMessage> {
    const row = await prisma.imapMessage.findUnique({ where: { id } });
    if (!row || row.emailAccountId !== this.emailAccountId) {
      throw new Error(`IMAP message not found: ${id}`);
    }
    return row;
  }

  private getThreadRows(threadId: string): Promise<ImapMessage[]> {
    return prisma.imapMessage.findMany({
      where: { emailAccountId: this.emailAccountId, threadId },
      orderBy: { date: "asc" },
    });
  }

  private async fetchSource(row: ImapMessage): Promise<Buffer> {
    return this.pool.withMailbox(row.folder, async (client) => {
      const message = await client.fetchOne(
        String(Number(row.uid)),
        { source: true },
        { uid: true },
      );
      if (!message) throw new Error("Failed to fetch message");
      const source = message.source;
      if (!source) throw new Error("Failed to fetch message source");
      return source;
    });
  }

  private async toMessage(row: ImapMessage): Promise<ParsedMessage> {
    const raw = await this.fetchSource(row);
    const message = await toParsedMessage(row, raw);
    message.labelIds = this.folderLabelIds(row.folder);
    return message;
  }

  // Maps the message's folder to the Gmail-style label ids the UI checks for
  // (SENT/DRAFT/INBOX/...). Folders are the IMAP equivalent of those labels.
  private folderLabelIds(folder: string): string[] {
    const ids: string[] = [];
    if (folder === this.special.inbox) ids.push("INBOX");
    if (folder === this.special.sent) ids.push("SENT");
    if (folder === this.special.drafts) ids.push("DRAFT");
    if (folder === this.special.archive) ids.push("ARCHIVE");
    if (folder === this.special.junk) ids.push("SPAM");
    if (folder === this.special.trash) ids.push("TRASH");
    return ids;
  }

  private async toMessages(rows: ImapMessage[]): Promise<ParsedMessage[]> {
    return Promise.all(rows.map((row) => this.toMessage(row)));
  }

  private async threadsFromRows(rows: ImapMessage[]): Promise<EmailThread[]> {
    const byThread = new Map<string, ImapMessage[]>();
    for (const row of rows) {
      const group = byThread.get(row.threadId);
      if (group) group.push(row);
      else byThread.set(row.threadId, [row]);
    }
    const threads: EmailThread[] = [];
    for (const [threadId, group] of byThread) {
      const messages = await this.toMessages(group);
      threads.push({
        id: threadId,
        messages,
        snippet: messages.at(-1)?.snippet ?? "",
      });
    }
    return threads;
  }

  // Folders to include in a body search when the query is not scoped to one.
  private searchFolders(): string[] {
    return [this.special.inbox, this.special.archive, this.special.sent].filter(
      (f): f is string => Boolean(f),
    );
  }

  /**
   * Builds the mirror `where` for a query. Free-text terms match subject/sender
   * in the mirror; since the message body is not mirrored, we additionally run a
   * server-side SEARCH BODY across the given folders and OR in those rows (still
   * subject to the query's structural filters).
   */
  private async buildSearchWhere(
    parsed: ReturnType<typeof parseQuery>,
    folders: string[],
  ): Promise<Prisma.ImapMessageWhereInput> {
    const metaWhere = buildWhere(parsed, this.emailAccountId);
    if (parsed.text.length === 0) return metaWhere;

    const bodyRowIds = await this.bodySearchRowIds(parsed.text, folders);
    if (bodyRowIds.length === 0) return metaWhere;

    const structuralWhere = buildWhere(parsed, this.emailAccountId, {
      includeText: false,
    });
    return {
      OR: [metaWhere, { AND: [structuralWhere, { id: { in: bodyRowIds } }] }],
    };
  }

  private async bodySearchRowIds(
    terms: string[],
    folders: string[],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const folder of folders) {
      const uids = await this.bodySearchUids(terms, folder);
      if (uids.length === 0) continue;
      const rows = await prisma.imapMessage.findMany({
        where: {
          emailAccountId: this.emailAccountId,
          folder,
          uid: { in: uids.map((u) => BigInt(u)) },
        },
        select: { id: true },
      });
      ids.push(...rows.map((r) => r.id));
    }
    return ids;
  }

  // Server-side SEARCH BODY for each term, intersected (AND) — returns UIDs.
  private async bodySearchUids(
    terms: string[],
    folder: string,
  ): Promise<number[]> {
    return this.pool.withMailbox(folder, async (client) => {
      let acc: number[] | null = null;
      for (const term of terms) {
        const result = await client.search({ body: term }, { uid: true });
        const found = Array.isArray(result) ? result : [];
        acc = acc === null ? found : acc.filter((u) => found.includes(u));
        if (acc.length === 0) return [];
      }
      return acc ?? [];
    });
  }

  private async pageMessages(
    where: Prisma.ImapMessageWhereInput,
    maxResults = 50,
    pageToken?: string,
  ): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    const offset = pageToken ? Number(pageToken) : 0;
    const rows = await prisma.imapMessage.findMany({
      where,
      orderBy: { date: "desc" },
      skip: offset,
      take: maxResults,
    });
    return {
      messages: await this.toMessages(rows),
      nextPageToken:
        rows.length === maxResults ? String(offset + rows.length) : undefined,
    };
  }

  private async setFlag(
    rows: ImapMessage[],
    flag: string,
    value: boolean,
  ): Promise<void> {
    await this.forEachFolderGroup(rows, async (client, uids) => {
      if (value) await client.messageFlagsAdd(uids, [flag], { uid: true });
      else await client.messageFlagsRemove(uids, [flag], { uid: true });
    });
  }

  private async forEachFolderGroup(
    rows: ImapMessage[],
    fn: (
      client: import("imapflow").ImapFlow,
      uids: number[],
      folder: string,
    ) => Promise<void>,
  ): Promise<void> {
    const byFolder = new Map<string, number[]>();
    for (const row of rows) {
      const uids = byFolder.get(row.folder) ?? [];
      uids.push(Number(row.uid));
      byFolder.set(row.folder, uids);
    }
    for (const [folder, uids] of byFolder) {
      await this.pool.withMailbox(folder, (client) => fn(client, uids, folder));
    }
  }

  private async moveRows(rows: ImapMessage[], target: string): Promise<void> {
    if (!this.capabilities.move) {
      // imapflow falls back to COPY + EXPUNGE; note it for diagnostics.
      this.logger.trace("Server lacks MOVE; using COPY+EXPUNGE fallback");
    }
    const byFolder = new Map<string, ImapMessage[]>();
    for (const row of rows) {
      if (row.folder === target) continue;
      const group = byFolder.get(row.folder) ?? [];
      group.push(row);
      byFolder.set(row.folder, group);
    }

    for (const [folder, group] of byFolder) {
      const uids = group.map((r) => Number(r.uid));
      const result = await this.pool.withMailbox(folder, (client) =>
        client.messageMove(uids, target, { uid: true }),
      );
      await this.applyMoveResult(group, target, result);
    }
  }

  private async applyMoveResult(
    rows: ImapMessage[],
    target: string,
    result: Awaited<ReturnType<import("imapflow").ImapFlow["messageMove"]>>,
  ): Promise<void> {
    if (!result) {
      // No UIDPLUS response: re-locate each message by its Message-ID.
      for (const row of rows) await this.relocateByMessageId(row, target);
      return;
    }
    const uidMap = result.uidMap;
    const uidValidity = result.uidValidity;

    for (const row of rows) {
      const newUid = uidMap?.get(Number(row.uid));
      if (newUid && uidValidity) {
        await prisma.imapMessage.update({
          where: { id: row.id },
          data: { folder: target, uid: BigInt(newUid), uidValidity },
        });
      } else {
        // Server gave no UIDPLUS mapping: re-locate by Message-ID in target.
        await this.relocateByMessageId(row, target);
      }
    }
  }

  private async relocateByMessageId(
    row: ImapMessage,
    target: string,
  ): Promise<void> {
    if (!row.messageIdHdr) {
      // Cannot relocate deterministically; drop so the next sync re-adds it.
      await prisma.imapMessage
        .delete({ where: { id: row.id } })
        .catch(() => {});
      return;
    }
    await this.pool.withMailbox(target, async (client) => {
      const mailbox = client.mailbox;
      const uidValidity = mailbox ? mailbox.uidValidity : BigInt(0);
      const found = await client.search(
        { header: { "message-id": row.messageIdHdr! } },
        { uid: true },
      );
      const newUid = Array.isArray(found) ? found.at(-1) : undefined;
      if (newUid) {
        await prisma.imapMessage.update({
          where: { id: row.id },
          data: { folder: target, uid: BigInt(newUid), uidValidity },
        });
      } else {
        await prisma.imapMessage
          .delete({ where: { id: row.id } })
          .catch(() => {});
      }
    });
  }

  private async moveRowsFromSenders(
    fromEmails: string[],
    target: string,
  ): Promise<void> {
    const rows = await prisma.imapMessage.findMany({
      where: {
        emailAccountId: this.emailAccountId,
        OR: fromEmails.map((email) => ({
          fromAddr: { contains: email, mode: "insensitive" as const },
        })),
      },
    });
    await this.moveRows(rows, target);
  }

  private async send(options: Mail.Options): Promise<{ messageId: string }> {
    const config = await getSmtpConfig({ emailAccountId: this.emailAccountId });
    // SMTP requires a From; the account's own address is the default sender.
    const withFrom: Mail.Options = {
      ...options,
      from: options.from ?? this.emailAddress,
    };
    const result = await sendViaSmtp(config, withFrom);
    await this.appendToSent(withFrom);
    return result;
  }

  private async appendToSent(options: Mail.Options): Promise<void> {
    if (!this.special.sent) return;
    try {
      const mime = await buildMime(options);
      await this.pool.withConnection((client) =>
        client.append(this.special.sent!, mime, ["\\Seen"]),
      );
    } catch (error) {
      this.logger.warn("Failed to append sent copy", { error });
    }
  }

  private async appendDraft(options: Mail.Options): Promise<{ id: string }> {
    if (!this.special.drafts) throw new Error("No drafts folder configured");
    const mime = await buildMime(options);
    const appendResult = await this.pool.withConnection((client) =>
      client.append(this.special.drafts!, mime, ["\\Draft"]),
    );

    const uid = appendResult ? appendResult.uid : undefined;
    const uidValidity = appendResult ? appendResult.uidValidity : undefined;
    if (!uid || !uidValidity) {
      // Without UIDPLUS we cannot address the draft; trigger a folder sync so
      // it gets a mirror row, then return that row's id.
      await syncFolder({
        pool: this.pool,
        emailAccountId: this.emailAccountId,
        folder: this.special.drafts,
      });
      const row = await prisma.imapMessage.findFirst({
        where: {
          emailAccountId: this.emailAccountId,
          folder: this.special.drafts,
        },
        orderBy: { date: "desc" },
      });
      if (!row) throw new Error("Failed to create draft");
      return { id: row.id };
    }

    const row = await prisma.imapMessage.create({
      data: {
        emailAccountId: this.emailAccountId,
        folder: this.special.drafts,
        uid: BigInt(uid),
        uidValidity: BigInt(uidValidity),
        threadId: randomUUID(),
        fromAddr: String(options.from ?? ""),
        subject: typeof options.subject === "string" ? options.subject : null,
        date: new Date(0),
        flagsSeen: true,
      },
    });
    return { id: row.id };
  }
}

function folderToLabel(path: string): EmailLabel {
  return { id: path, name: path, type: "user" };
}

function dateRange(after?: Date, before?: Date) {
  if (!after && !before) return;
  return {
    ...(after ? { gte: after } : {}),
    ...(before ? { lt: before } : {}),
  };
}

function extractEmail(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match ? match[1] : value).trim();
}

function ensureRePrefix(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function ensureFwdPrefix(subject: string): string {
  return /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`;
}
