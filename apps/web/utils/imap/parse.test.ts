import { describe, expect, it } from "vitest";
import { toParsedMessage } from "./parse";

const RAW = [
  "From: Alice <alice@example.com>",
  "To: Bob <bob@example.com>",
  "Subject: Hello there",
  "Message-ID: <msg-1@example.com>",
  "In-Reply-To: <root@example.com>",
  "References: <root@example.com>",
  "Date: Wed, 04 Jun 2025 10:00:00 +0000",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "This is the body of the message.",
  "",
].join("\r\n");

const row = {
  id: "row-1",
  threadId: "thread-1",
  folder: "INBOX",
  snippet: null,
};

describe("toParsedMessage", () => {
  it("maps headers and body, taking id/threadId from the row", async () => {
    const message = await toParsedMessage(row, RAW);

    expect(message.id).toBe("row-1");
    expect(message.threadId).toBe("thread-1");
    expect(message.parentFolderId).toBe("INBOX");
    expect(message.subject).toBe("Hello there");
    expect(message.headers.from).toContain("alice@example.com");
    expect(message.headers.to).toContain("bob@example.com");
    expect(message.headers["message-id"]).toBe("<msg-1@example.com>");
    expect(message.headers["in-reply-to"]).toBe("<root@example.com>");
    expect(message.textPlain).toContain("body of the message");
  });

  it("derives a snippet when the row has none", async () => {
    const message = await toParsedMessage(row, RAW);
    expect(message.snippet).toContain("body of the message");
  });
});
