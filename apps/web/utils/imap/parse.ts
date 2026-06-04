import { simpleParser, type ParsedMail, type AddressObject } from "mailparser";
import type { ImapMessage } from "@/generated/prisma/client";
import type { ParsedMessage, ParsedMessageHeaders } from "@/utils/types";

/**
 * Converts a raw RFC822 message (as fetched from IMAP) plus its mirror-table
 * row into the app-wide `ParsedMessage`. The stable `id` and `threadId` come
 * from the row, not the wire message — IMAP has neither natively.
 */
export async function toParsedMessage(
  row: Pick<ImapMessage, "id" | "threadId" | "folder" | "snippet">,
  raw: Buffer | string,
): Promise<ParsedMessage> {
  const mail = await simpleParser(raw);
  return mapParsedMail(row, mail);
}

export function mapParsedMail(
  row: Pick<ImapMessage, "id" | "threadId" | "folder" | "snippet">,
  mail: ParsedMail,
): ParsedMessage {
  const headers = buildHeaders(mail);
  const date = (mail.date ?? new Date(0)).toISOString();
  const html = typeof mail.html === "string" ? mail.html : undefined;
  const textPlain = mail.text ?? undefined;
  const snippet =
    row.snippet ?? buildSnippet(textPlain ?? mail.textAsHtml ?? "");

  const attachments = mail.attachments
    .filter((a) => a.contentDisposition !== "inline" || !a.contentId)
    .map((a, index) => ({
      attachmentId: String(index),
      filename: a.filename ?? `attachment-${index}`,
      mimeType: a.contentType,
      size: a.size,
      headers: attachmentHeaders(a.contentType),
    }));

  const inline = mail.attachments
    .filter((a) => a.contentDisposition === "inline" && a.contentId)
    .map((a, index) => ({
      attachmentId: String(index),
      filename: a.filename ?? `inline-${index}`,
      mimeType: a.contentType,
      size: a.size,
      headers: attachmentHeaders(a.contentType),
    }));

  return {
    id: row.id,
    threadId: row.threadId,
    parentFolderId: row.folder,
    date,
    headers,
    historyId: "",
    snippet,
    subject: mail.subject ?? "",
    textHtml: html,
    textPlain,
    attachments,
    inline,
  };
}

function buildHeaders(mail: ParsedMail): ParsedMessageHeaders {
  return {
    from: addressText(mail.from),
    to: addressText(mail.to),
    cc: addressText(mail.cc) || undefined,
    bcc: addressText(mail.bcc) || undefined,
    subject: mail.subject ?? "",
    date: (mail.date ?? new Date(0)).toISOString(),
    "message-id": mail.messageId,
    "in-reply-to": mail.inReplyTo,
    references: referencesText(mail.references),
    "reply-to": addressText(mail.replyTo) || undefined,
    "list-unsubscribe": singleHeader(mail, "list-unsubscribe"),
  };
}

function addressText(
  address: AddressObject | AddressObject[] | undefined,
): string {
  if (!address) return "";
  if (Array.isArray(address)) return address.map((a) => a.text).join(", ");
  return address.text;
}

function referencesText(
  references: string | string[] | undefined,
): string | undefined {
  if (!references) return;
  return Array.isArray(references) ? references.join(" ") : references;
}

function singleHeader(mail: ParsedMail, name: string): string | undefined {
  const value = mail.headers.get(name);
  if (!value) return;
  return typeof value === "string" ? value : String(value);
}

function attachmentHeaders(contentType: string) {
  return {
    "content-description": "",
    "content-id": "",
    "content-transfer-encoding": "",
    "content-type": contentType,
  };
}

function buildSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}
