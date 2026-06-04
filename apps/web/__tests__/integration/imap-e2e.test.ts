import { afterAll, beforeAll, describe, expect, it } from "vitest";
import nodemailer from "nodemailer";
import prisma from "@/utils/prisma";
import { encryptToken } from "@/utils/encryption";
import { ImapProvider } from "@/utils/email/imap";
import { getImapPoolForEmail } from "@/utils/imap/connection";
import { syncFolder } from "@/utils/imap/sync";
import { createScopedLogger } from "@/utils/logger";

/**
 * End-to-end test of the IMAP driver against a real IMAP/SMTP server (GreenMail)
 * and a real Postgres. Seeds a thread over SMTP, syncs it into the mirror table,
 * then drives the provider: inbox listing, threading, read flags, and a folder
 * move (which changes the underlying UID but must keep the app-facing id stable).
 *
 *   docker run -d --name greenmail-iz -p 3143:3143 -p 3025:3025 \
 *     -e GREENMAIL_OPTS="-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 \
 *        -Dgreenmail.users=test:test@localhost" greenmail/standalone:2.0.1
 *
 *   docker run -d --name iz-pg -p 5544:5432 -e POSTGRES_PASSWORD=password \
 *     -e POSTGRES_DB=inboxzero postgres:16
 *   DATABASE_URL=postgresql://postgres:password@localhost:5544/inboxzero \
 *     pnpm exec prisma db push --url "$DATABASE_URL"
 *
 *   RUN_INTEGRATION_TESTS=true IMAP_TEST_HOST=localhost IMAP_TEST_PORT=3143 \
 *   IMAP_TEST_SECURE=false IMAP_TEST_USER=test IMAP_TEST_PASS=test \
 *   SMTP_TEST_PORT=3025 \
 *   DATABASE_URL=postgresql://postgres:password@localhost:5544/inboxzero \
 *   npx vitest --run __tests__/integration/imap-e2e.test.ts
 */
const enabled =
  !!process.env.RUN_INTEGRATION_TESTS && !!process.env.IMAP_TEST_HOST;

const host = process.env.IMAP_TEST_HOST ?? "localhost";
const imapPort = Number(process.env.IMAP_TEST_PORT ?? 3143);
const imapSecure = process.env.IMAP_TEST_SECURE === "true";
const user = process.env.IMAP_TEST_USER ?? "test";
const pass = process.env.IMAP_TEST_PASS ?? "test";
const smtpPort = Number(process.env.SMTP_TEST_PORT ?? 3025);

const EMAIL = "imap-e2e@example.com";
const RECIPIENT = "test@localhost";
const logger = createScopedLogger("imap-e2e-test");

describe.skipIf(!enabled)("IMAP provider e2e", { timeout: 60_000 }, () => {
  let emailAccountId: string;
  let provider: ImapProvider;

  beforeAll(async () => {
    await cleanup();

    const user_ = await prisma.user.create({
      data: { email: EMAIL },
    });
    const account = await prisma.account.create({
      data: {
        userId: user_.id,
        type: "imap",
        provider: "imap",
        providerAccountId: EMAIL,
        imapHost: host,
        imapPort,
        imapSecure,
        imapUsername: user,
        imapPassword: encryptToken(pass),
        smtpHost: host,
        smtpPort,
        smtpSecure: false,
        emailAccount: { create: { email: EMAIL, userId: user_.id } },
      },
      include: { emailAccount: true },
    });
    emailAccountId = account.emailAccount!.id;

    const pool = await getImapPoolForEmail({ emailAccountId });
    await purgeInbox(pool);
    await seedThread();
    await syncFolder({ pool, emailAccountId, folder: "INBOX" });

    provider = await ImapProvider.create({ emailAccountId, logger });
  });

  afterAll(async () => {
    await cleanup();
  });

  it("lists seeded inbox messages", async () => {
    const messages = await provider.getInboxMessages(50);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages.some((m) => m.subject === "E2E original")).toBe(true);
    expect(messages.some((m) => m.subject === "Re: E2E original")).toBe(true);
  });

  it("groups the reply into the same thread as the original", async () => {
    const rows = await prisma.imapMessage.findMany({
      where: { emailAccountId },
    });
    const threadIds = new Set(rows.map((r) => r.threadId));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(threadIds.size).toBe(1);
  });

  it("marks a thread as read", async () => {
    const before = await provider.getInboxStats();
    expect(before.unread).toBeGreaterThan(0);

    const row = await prisma.imapMessage.findFirstOrThrow({
      where: { emailAccountId },
    });
    await provider.markReadThread(row.threadId, true);

    const after = await provider.getInboxStats();
    expect(after.unread).toBe(0);
  });

  it("moves a thread to a folder, keeping the app-facing id stable", async () => {
    const row = await prisma.imapMessage.findFirstOrThrow({
      where: { emailAccountId, folder: "INBOX" },
    });
    const stableId = row.id;
    const threadId = row.threadId;

    await provider.moveThreadToFolder(threadId, EMAIL, "Archive");

    // Same id resolves, now located in the Archive folder.
    const moved = await provider.getMessage(stableId);
    expect(moved.id).toBe(stableId);
    expect(moved.parentFolderId).toBe("Archive");

    // No longer counted in the inbox.
    const inboxRows = await prisma.imapMessage.count({
      where: { emailAccountId, folder: "INBOX" },
    });
    expect(inboxRows).toBe(0);
  });
});

async function purgeInbox(
  pool: Awaited<ReturnType<typeof getImapPoolForEmail>>,
) {
  await pool.withMailbox("INBOX", async (client) => {
    try {
      await client.messageDelete("1:*");
    } catch {
      // empty mailbox
    }
  });
}

async function seedThread() {
  const transport = nodemailer.createTransport({
    host,
    port: smtpPort,
    secure: false,
    auth: { user, pass },
  });

  const originalId = "<e2e-original@example.com>";
  await transport.sendMail({
    from: "alice@example.com",
    to: RECIPIENT,
    subject: "E2E original",
    text: "This is the original message.",
    messageId: originalId,
  });
  await transport.sendMail({
    from: "alice@example.com",
    to: RECIPIENT,
    subject: "Re: E2E original",
    text: "This is the reply.",
    inReplyTo: originalId,
    references: originalId,
  });

  // Give GreenMail a moment to deliver before syncing.
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function cleanup() {
  await prisma.imapMessage.deleteMany({
    where: { emailAccount: { email: EMAIL } },
  });
  await prisma.user.deleteMany({ where: { email: EMAIL } });
}
