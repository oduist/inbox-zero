import { describe, expect, it } from "vitest";
import { buildWhere, parseQuery } from "./query";

describe("parseQuery", () => {
  it("parses field tokens and free text", () => {
    const parsed = parseQuery('from:alice@x.com subject:"hello world" urgent');
    expect(parsed.from).toBe("alice@x.com");
    expect(parsed.subject).toBe("hello world");
    expect(parsed.text).toEqual(["urgent"]);
  });

  it("parses is:unread and has:attachment", () => {
    const parsed = parseQuery("is:unread has:attachment");
    expect(parsed.isUnread).toBe(true);
    expect(parsed.hasAttachment).toBe(true);
  });

  it("parses dates", () => {
    const parsed = parseQuery("after:2024/01/15");
    expect(parsed.after?.getUTCFullYear()).toBe(2024);
  });

  it("records unsupported operators instead of failing", () => {
    const parsed = parseQuery("label:work is:starred");
    expect(parsed.unsupported).toContain("label:work");
    expect(parsed.unsupported).toContain("is:starred");
  });
});

describe("buildWhere", () => {
  it("scopes to the account and translates fields", () => {
    const where = buildWhere(parseQuery("from:bob is:unread"), "acc1");
    expect(JSON.stringify(where)).toContain("acc1");
    expect(JSON.stringify(where)).toContain("flagsSeen");
  });

  it("maps rfc822msgid to messageIdHdr with angle brackets", () => {
    const where = buildWhere(parseQuery("rfc822msgid:abc@x"), "acc1");
    expect(JSON.stringify(where)).toContain("<abc@x>");
  });

  it("returns a bare account filter for an empty query", () => {
    const where = buildWhere(parseQuery(""), "acc1");
    expect(where).toEqual({ emailAccountId: "acc1" });
  });
});
