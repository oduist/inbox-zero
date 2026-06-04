import type { Prisma } from "@/generated/prisma/client";

/**
 * Normalized form of a Gmail-style search query. The app builds queries in
 * Gmail syntax (`from:x after:y is:unread`); for IMAP we translate the parts we
 * can express against the mirror table and drop the rest (recorded in
 * `unsupported`) rather than failing.
 */
export interface ParsedQuery {
  after?: Date;
  before?: Date;
  from?: string;
  hasAttachment?: boolean;
  isUnread?: boolean;
  rfc822msgid?: string;
  subject?: string;
  text: string[];
  to?: string;
  unsupported: string[];
}

const FIELD_TOKEN = /(\w+):("[^"]*"|\S+)/g;

export function parseQuery(query: string | undefined): ParsedQuery {
  const result: ParsedQuery = { text: [], unsupported: [] };
  if (!query) return result;

  let remaining = query;
  for (const match of query.matchAll(FIELD_TOKEN)) {
    const [token, field, rawValue] = match;
    const value = unquote(rawValue);
    remaining = remaining.replace(token, " ");
    applyField(result, field.toLowerCase(), value, token);
  }

  for (const word of remaining.split(/\s+/)) {
    const trimmed = word.trim();
    if (trimmed) result.text.push(trimmed);
  }

  return result;
}

/**
 * Builds a Prisma `where` for the ImapMessage mirror table from a parsed query.
 * Free text matches subject or sender (IMAP body full-text search is not
 * mirrored). Caller scopes by emailAccountId.
 */
export function buildWhere(
  parsed: ParsedQuery,
  emailAccountId: string,
): Prisma.ImapMessageWhereInput {
  const and: Prisma.ImapMessageWhereInput[] = [{ emailAccountId }];

  if (parsed.from)
    and.push({ fromAddr: { contains: parsed.from, mode: "insensitive" } });
  if (parsed.subject)
    and.push({ subject: { contains: parsed.subject, mode: "insensitive" } });
  if (parsed.rfc822msgid)
    and.push({ messageIdHdr: normalizeAngle(parsed.rfc822msgid) });
  if (parsed.after) and.push({ date: { gte: parsed.after } });
  if (parsed.before) and.push({ date: { lt: parsed.before } });
  if (parsed.isUnread !== undefined) and.push({ flagsSeen: !parsed.isUnread });
  if (parsed.hasAttachment) and.push({ hasAttachments: true });

  for (const word of parsed.text) {
    and.push({
      OR: [
        { subject: { contains: word, mode: "insensitive" } },
        { fromAddr: { contains: word, mode: "insensitive" } },
      ],
    });
  }

  return and.length === 1 ? and[0] : { AND: and };
}

function applyField(
  result: ParsedQuery,
  field: string,
  value: string,
  token: string,
): void {
  switch (field) {
    case "from":
      result.from = value;
      break;
    case "to":
      result.to = value;
      break;
    case "subject":
      result.subject = value;
      break;
    case "rfc822msgid":
      result.rfc822msgid = value;
      break;
    case "after":
    case "newer":
      result.after = parseDate(value);
      break;
    case "before":
    case "older":
      result.before = parseDate(value);
      break;
    case "is":
      if (value === "unread") result.isUnread = true;
      else if (value === "read") result.isUnread = false;
      else result.unsupported.push(token);
      break;
    case "has":
      if (value === "attachment") result.hasAttachment = true;
      else result.unsupported.push(token);
      break;
    default:
      result.unsupported.push(token);
  }
}

function parseDate(value: string): Date | undefined {
  const date = new Date(value.replace(/\//g, "-"));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function normalizeAngle(id: string): string {
  return id.startsWith("<") ? id : `<${id}>`;
}
