import { describe, expect, it } from "vitest";
import {
  groupIntoThreads,
  linkedMessageIds,
  normalizeMessageId,
  parseReferences,
} from "./thread";

describe("normalizeMessageId", () => {
  it("extracts the angle-bracketed id", () => {
    expect(normalizeMessageId("  <abc@x.com> ")).toBe("<abc@x.com>");
  });

  it("returns null for empty input", () => {
    expect(normalizeMessageId(undefined)).toBeNull();
    expect(normalizeMessageId("")).toBeNull();
  });
});

describe("parseReferences", () => {
  it("splits multiple references", () => {
    expect(parseReferences("<a@x> <b@x>\n <c@x>")).toEqual([
      "<a@x>",
      "<b@x>",
      "<c@x>",
    ]);
  });

  it("returns empty for missing value", () => {
    expect(parseReferences(null)).toEqual([]);
  });
});

describe("linkedMessageIds", () => {
  it("includes self, in-reply-to and references", () => {
    expect(
      linkedMessageIds({
        messageId: "<self@x>",
        inReplyTo: "<parent@x>",
        references: "<root@x> <parent@x>",
      }),
    ).toEqual(expect.arrayContaining(["<self@x>", "<parent@x>", "<root@x>"]));
  });
});

describe("groupIntoThreads", () => {
  it("groups messages connected through references", () => {
    const groups = groupIntoThreads([
      { messageId: "<a@x>", inReplyTo: null, references: null },
      { messageId: "<b@x>", inReplyTo: "<a@x>", references: "<a@x>" },
      { messageId: "<c@x>", inReplyTo: "<b@x>", references: "<a@x> <b@x>" },
      { messageId: "<z@x>", inReplyTo: null, references: null },
    ]);

    const sorted = groups.map((g) => g.sort((a, b) => a - b)).sort();
    expect(sorted).toContainEqual([0, 1, 2]);
    expect(sorted).toContainEqual([3]);
  });

  it("keeps unrelated messages in separate threads", () => {
    const groups = groupIntoThreads([
      { messageId: "<a@x>", inReplyTo: null, references: null },
      { messageId: "<b@x>", inReplyTo: null, references: null },
    ]);
    expect(groups).toHaveLength(2);
  });

  it("merges via shared reference even without direct reply link", () => {
    const groups = groupIntoThreads([
      { messageId: "<a@x>", inReplyTo: null, references: "<root@x>" },
      { messageId: "<b@x>", inReplyTo: null, references: "<root@x>" },
    ]);
    expect(groups).toHaveLength(1);
  });
});
