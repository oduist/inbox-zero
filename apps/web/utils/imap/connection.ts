import { ImapFlow, type MailboxLockObject } from "imapflow";
import prisma from "@/utils/prisma";
import { decryptToken } from "@/utils/encryption";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("imap/connection");

export interface ImapConnectionConfig {
  auth: { user: string; pass: string };
  host: string;
  port: number;
  secure: boolean;
}

/**
 * IMAP is a stateful, long-lived socket protocol, unlike the stateless HTTP
 * calls the Gmail/Outlook providers make. A small per-account pool keeps a few
 * authenticated connections warm and hands them out for short operations.
 */
export class ImapPool {
  private readonly idle: ImapFlow[] = [];
  private readonly max = 3;
  private readonly config: ImapConnectionConfig;

  constructor(config: ImapConnectionConfig) {
    this.config = config;
  }

  async withConnection<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = this.idle.pop() ?? (await this.connect());
    try {
      return await fn(client);
    } finally {
      this.release(client);
    }
  }

  /**
   * Selects a mailbox under a lock (imapflow serializes mailbox access per
   * connection) and runs `fn` while it is the active mailbox.
   */
  async withMailbox<T>(
    path: string,
    fn: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    return this.withConnection(async (client) => {
      const lock: MailboxLockObject = await client.getMailboxLock(path);
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    });
  }

  async close(): Promise<void> {
    const clients = this.idle.splice(0);
    await Promise.all(clients.map((c) => c.logout().catch(() => {})));
  }

  private release(client: ImapFlow): void {
    if (client.usable && this.idle.length < this.max) {
      this.idle.push(client);
    } else {
      client.logout().catch(() => {});
    }
  }

  private async connect(): Promise<ImapFlow> {
    const client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: this.config.auth,
      logger: false,
    });
    await client.connect();
    return client;
  }
}

/**
 * Verifies credentials by opening and tearing down a single connection.
 * Returns the detected mailbox list size on success, throws on failure.
 */
export async function verifyImapConnection(
  config: ImapConnectionConfig,
): Promise<void> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
    logger: false,
  });
  await client.connect();
  await client.logout();
}

// Reuse pools across calls within a process so warm connections are not thrown
// away between requests.
const poolRegistry = new Map<string, ImapPool>();

export async function getImapPoolForEmail({
  emailAccountId,
}: {
  emailAccountId: string;
}): Promise<ImapPool> {
  const existing = poolRegistry.get(emailAccountId);
  if (existing) return existing;

  const config = await getImapConfig({ emailAccountId });
  const pool = new ImapPool(config);
  poolRegistry.set(emailAccountId, pool);
  return pool;
}

export async function getImapConfig({
  emailAccountId,
}: {
  emailAccountId: string;
}): Promise<ImapConnectionConfig> {
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: {
      account: {
        select: {
          imapHost: true,
          imapPort: true,
          imapSecure: true,
          imapUsername: true,
          imapPassword: true,
        },
      },
    },
  });

  const account = emailAccount?.account;
  if (!account?.imapHost || !account.imapPort || !account.imapUsername) {
    logger.error("IMAP account is not fully configured", { emailAccountId });
    throw new Error("IMAP account is not configured");
  }

  const pass = decryptToken(account.imapPassword);
  if (!pass)
    throw new Error("IMAP password is missing or could not be decrypted");

  return {
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure ?? true,
    auth: { user: account.imapUsername, pass },
  };
}
