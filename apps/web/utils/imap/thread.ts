/**
 * Thread grouping for IMAP, which has no native thread/conversation id.
 *
 * We group messages by the JWZ-style reference graph: every message links to
 * the other message-ids it mentions in `In-Reply-To` and `References`. Messages
 * connected through that graph share a thread. This is used during sync to
 * assign a stable synthetic `threadId` to each message.
 */

export interface ThreadableMessage {
  inReplyTo?: string | null;
  messageId?: string | null;
  references?: string | null;
}

export function parseReferences(value?: string | null): string[] {
  if (!value) return [];
  const ids = value.match(/<[^>]+>/g);
  return ids ? ids.map((id) => id.trim()) : [];
}

export function normalizeMessageId(value?: string | null): string | null {
  if (!value) return null;
  const match = value.match(/<[^>]+>/);
  return (match ? match[0] : value).trim() || null;
}

/**
 * Returns the set of message-ids a message is linked to (itself + everything it
 * references). Used to union messages into threads.
 */
export function linkedMessageIds(message: ThreadableMessage): string[] {
  const ids = new Set<string>();
  const self = normalizeMessageId(message.messageId);
  if (self) ids.add(self);
  const inReplyTo = normalizeMessageId(message.inReplyTo);
  if (inReplyTo) ids.add(inReplyTo);
  for (const ref of parseReferences(message.references)) ids.add(ref);
  return [...ids];
}

/**
 * Groups a batch of messages into threads using union-find over their reference
 * graph. Returns an array of groups (each group is the list of input indexes
 * that belong together). Order within a group follows input order.
 */
export function groupIntoThreads(messages: ThreadableMessage[]): number[][] {
  const parent: number[] = messages.map((_, i) => i);

  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    // Path compression: point every node on the path directly at the root.
    let node = x;
    while (parent[node] !== root) {
      const next = parent[node];
      parent[node] = root;
      node = next;
    }
    return root;
  };

  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  // Map each message-id to the first message index that owns/mentions it.
  const idToIndex = new Map<string, number>();
  messages.forEach((message, index) => {
    for (const id of linkedMessageIds(message)) {
      const existing = idToIndex.get(id);
      if (existing === undefined) idToIndex.set(id, index);
      else union(existing, index);
    }
  });

  const groups = new Map<number, number[]>();
  messages.forEach((_, index) => {
    const root = find(index);
    const group = groups.get(root);
    if (group) group.push(index);
    else groups.set(root, [index]);
  });

  return [...groups.values()];
}
