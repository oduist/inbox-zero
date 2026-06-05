import prisma from "@/utils/prisma";
import { getImapPoolForEmail } from "@/utils/imap/connection";
import { resolveSpecialFolders } from "@/utils/imap/capabilities";
import { syncFolder } from "@/utils/imap/sync";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("imap/sync-account");

/**
 * Syncs an IMAP account's folders into the mirror table. Used to populate the
 * inbox on connect and to refresh it when the mail list is opened (incremental
 * sync is cheap after the first run). Best-effort per folder.
 */
export async function syncImapAccount({
  emailAccountId,
  initialLimit,
  includeAllFolders = false,
}: {
  emailAccountId: string;
  /** Cap the first sync of each folder to roughly the most recent N messages. */
  initialLimit?: number;
  /** Also sync Sent/Drafts/Archive (used on connect); otherwise just the inbox. */
  includeAllFolders?: boolean;
}): Promise<void> {
  const pool = await getImapPoolForEmail({ emailAccountId });
  const account = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: { imapSpecialFolders: true },
  });
  const override =
    (account?.imapSpecialFolders as
      | Partial<Record<string, string>>
      | null
      | undefined) ?? undefined;
  const special = await resolveSpecialFolders(pool, override);

  const folders = includeAllFolders
    ? [special.inbox, special.sent, special.drafts, special.archive]
    : [special.inbox];

  for (const folder of folders) {
    if (!folder) continue;
    try {
      await syncFolder({ pool, emailAccountId, folder, limit: initialLimit });
    } catch (error) {
      logger.warn("Folder sync failed", { emailAccountId, folder, error });
    }
  }
}
