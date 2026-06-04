import { describe, expect, it, beforeAll } from "vitest";
import { ImapPool, verifyImapConnection } from "@/utils/imap/connection";
import { resolveSpecialFolders } from "@/utils/imap/capabilities";

/**
 * Integration tests for the IMAP driver against a real server.
 *
 * These are skipped unless IMAP_TEST_HOST is set. To run locally, start a
 * disposable server, e.g. GreenMail:
 *
 *   docker run -d --name greenmail -p 3143:3143 -p 3025:3025 \
 *     -e GREENMAIL_OPTS="-Dgreenmail.setup.test.all -Dgreenmail.users=test:test@localhost" \
 *     greenmail/standalone:2.0.1
 *
 *   IMAP_TEST_HOST=localhost IMAP_TEST_PORT=3143 IMAP_TEST_SECURE=false \
 *   IMAP_TEST_USER=test IMAP_TEST_PASS=test pnpm test-integration imap-provider
 */
const host = process.env.IMAP_TEST_HOST;

const config = {
  host: host ?? "",
  port: Number(process.env.IMAP_TEST_PORT ?? 993),
  secure: process.env.IMAP_TEST_SECURE !== "false",
  auth: {
    user: process.env.IMAP_TEST_USER ?? "",
    pass: process.env.IMAP_TEST_PASS ?? "",
  },
};

describe.skipIf(!host)("ImapProvider integration", () => {
  let pool: ImapPool;

  beforeAll(() => {
    pool = new ImapPool(config);
  });

  it("connects with valid credentials", async () => {
    await expect(verifyImapConnection(config)).resolves.toBeUndefined();
  });

  it("resolves an inbox folder", async () => {
    const special = await resolveSpecialFolders(pool);
    expect(special.inbox).toBeTruthy();
  });

  it("lists mailboxes", async () => {
    const boxes = await pool.withConnection((c) => c.list());
    expect(Array.isArray(boxes)).toBe(true);
    expect(boxes.length).toBeGreaterThan(0);
  });
});
