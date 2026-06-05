import type { ImapPool } from "@/utils/imap/connection";

export type SpecialFolderKey = "sent" | "archive" | "trash" | "junk" | "drafts";

export type SpecialFolders = Record<SpecialFolderKey, string | undefined> & {
  inbox: string;
};

export interface ImapCapabilities {
  condstore: boolean;
  idle: boolean;
  move: boolean;
  thread: boolean;
}

// SPECIAL-USE flags (RFC 6154) mapped to our keys.
const SPECIAL_USE_FLAG: Record<SpecialFolderKey, string> = {
  sent: "\\Sent",
  archive: "\\Archive",
  trash: "\\Trash",
  junk: "\\Junk",
  drafts: "\\Drafts",
};

// Name heuristics for servers without SPECIAL-USE. Multilingual on purpose:
// the product targets any IMAP server, so we cannot assume English folders.
const NAME_HINTS: Record<SpecialFolderKey, string[]> = {
  sent: ["sent", "отправленные", "gesendet", "envoyés", "wysłane", "enviados"],
  archive: ["archive", "archiv", "архив", "archives", "archiwum"],
  trash: ["trash", "deleted", "корзина", "papierkorb", "corbeille", "kosz"],
  junk: ["junk", "spam", "спам", "bulk"],
  drafts: ["drafts", "draft", "черновики", "entwürfe", "brouillons", "wersje"],
};

export async function detectCapabilities(
  pool: ImapPool,
): Promise<ImapCapabilities> {
  return pool.withConnection(async (client) => {
    const has = (name: string) => client.capabilities.has(name.toUpperCase());
    return {
      move: has("MOVE"),
      thread: [...client.capabilities].some((c) =>
        String(c).toUpperCase().startsWith("THREAD"),
      ),
      condstore: has("CONDSTORE"),
      idle: has("IDLE"),
    };
  });
}

export async function resolveSpecialFolders(
  pool: ImapPool,
  override?: Partial<Record<SpecialFolderKey, string>>,
): Promise<SpecialFolders> {
  return pool.withConnection(async (client) => {
    const boxes = await client.list();

    const bySpecialUse = (key: SpecialFolderKey) =>
      boxes.find((b) => b.specialUse === SPECIAL_USE_FLAG[key])?.path;

    const byName = (key: SpecialFolderKey) => {
      const hints = NAME_HINTS[key];
      return boxes.find((b) =>
        hints.some((h) => b.path.toLowerCase().includes(h)),
      )?.path;
    };

    const resolve = (key: SpecialFolderKey) =>
      override?.[key] ?? bySpecialUse(key) ?? byName(key);

    const inbox =
      boxes.find((b) => b.specialUse === "\\Inbox")?.path ??
      boxes.find((b) => b.path.toUpperCase() === "INBOX")?.path ??
      "INBOX";

    return {
      inbox,
      sent: resolve("sent"),
      archive: resolve("archive"),
      trash: resolve("trash"),
      junk: resolve("junk"),
      drafts: resolve("drafts"),
    };
  });
}
