import { ApiError } from "./api";
import type { Chat, ChatMessage, ConnectionInfo, DeliveryStatus } from "./types";

/*
 * Connect chats as kept on a device, and the delivery rules both apps share:
 *
 * - Sending: the message goes into the chat at once with a client_id and status "sending", is saved on the
 *   device, then sent. Network errors and server hiccups are retried with backoff (sendDelays); the server
 *   recognises the client_id, so a retry never creates a duplicate. When the server answers, the local copy
 *   is replaced by the saved one ("sent"). Errors that a retry can't fix (quota, disconnected) mark it
 *   "failed" with a Retry button.
 * - Receiving: the inbox may offer the same message again (until this device confirms it), so merging skips
 *   anything already present by server id or client_id. Messages always carry the other person, so a chat
 *   this device hasn't seen yet is created instead of the message being dropped. The device confirms
 *   (acks) only after the merged chats are saved.
 * - Delivered: the sender's app asks for receipts of its "sent" messages and marks them "delivered".
 */

/** Pure merge of inbox messages into this device's chats. Returns the new list and the messages that are new. */
export function mergeInbox(chats: Chat[], incoming: ChatMessage[]): { chats: Chat[]; fresh: ChatMessage[] } {
  const byId = new Map(chats.map((c) => [c.id, { ...c, messages: [...c.messages] }]));
  const fresh: ChatMessage[] = [];
  for (const m of incoming) {
    let chat = byId.get(m.connection_id);
    if (!chat) {
      // Server messages always name the other person; fall back to a placeholder rather than dropping it.
      const peer = m.peer ?? { id: "", name: "Someone", language: m.source || "en-US", gender: m.gender ?? "female" };
      chat = { id: m.connection_id, peer, since: m.at, ended: false, unread: 0, messages: [], updatedAt: Date.now() };
      byId.set(chat.id, chat);
    }
    const dupe = chat.messages.findIndex((x) => x.id === m.id || (!!m.client_id && x.client_id === m.client_id));
    if (dupe >= 0) {
      // Same message again (or my own message synced from my other device): keep one copy, best status.
      const prev = chat.messages[dupe];
      if (m.from_me) chat.messages[dupe] = { ...prev, ...m, peer: undefined, status: bestStatus(prev.status, m.status) };
      continue;
    }
    if (m.kind === "ended") chat.ended = true;
    if (m.kind === "joined" && m.peer) { chat.peer = m.peer; chat.ended = false; }
    const { peer: _peer, ...stored } = m;
    chat.messages.push(stored);
    chat.messages.sort(byTime);
    if (!m.from_me) chat.unread += m.kind === "text" || m.kind === "voice" ? 1 : 0;
    chat.updatedAt = Date.now();
    fresh.push(m);
  }
  return { chats: sortChats([...byId.values()]), fresh };
}

const RANK: Record<DeliveryStatus, number> = { failed: 0, sending: 1, sent: 2, delivered: 3 };
function bestStatus(a?: DeliveryStatus | null, b?: DeliveryStatus | null): DeliveryStatus | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

function byTime(a: ChatMessage, b: ChatMessage): number {
  return Date.parse(a.at) - Date.parse(b.at);
}

/** Adds chats the server knows about (e.g. just joined) and marks chats the server no longer lists as ended. */
export function syncConnections(chats: Chat[], live: ConnectionInfo[]): Chat[] {
  const liveIds = new Set(live.map((c) => c.id));
  const out = chats.map((c) => (!liveIds.has(c.id) && !c.ended ? { ...c, ended: true } : c));
  for (const c of live) {
    const existing = out.find((x) => x.id === c.id);
    if (existing) Object.assign(existing, { peer: c.peer, ended: false });
    else out.push({ id: c.id, peer: c.peer, since: c.since, ended: false, unread: 0, messages: [], updatedAt: Date.now() });
  }
  return sortChats(out);
}

/* ---------- Sending ---------- */

/** A random id for a new message (also accepted by the server: 8-40 letters, digits, - or _). */
export function newClientId(): string {
  const rand = () => Math.random().toString(36).slice(2, 10);
  return `m${Date.now().toString(36)}${rand()}${rand()}`.slice(0, 32);
}

/** The local copy of a message being sent, shown at once with status "sending". */
export function pendingMessage(connectionId: string, clientId: string, input: { text?: string; audioUri?: string },
  lang: string): ChatMessage {
  return {
    id: `local-${clientId}`, client_id: clientId, connection_id: connectionId, kind: input.text != null ? "text" : "voice",
    from_me: true, status: "sending", original: input.text ?? "🎙 …", source: lang, translation: "", target: "",
    gender: null, at: new Date().toISOString(), audio_uri: input.audioUri,
  };
}

function updateMessage(chats: Chat[], clientId: string, fn: (m: ChatMessage) => ChatMessage): Chat[] {
  return chats.map((c) => {
    const i = c.messages.findIndex((m) => m.client_id === clientId);
    if (i < 0) return c;
    const messages = [...c.messages];
    messages[i] = fn(messages[i]);
    return { ...c, messages, updatedAt: Date.now() };
  });
}

/** Puts a new outgoing message into its chat. */
export function addPending(chats: Chat[], m: ChatMessage): Chat[] {
  return sortChats(chats.map((c) => (c.id === m.connection_id ? { ...c, messages: [...c.messages, m], updatedAt: Date.now() } : c)));
}

/** The server saved it: swap the local copy for the server's (keeps "delivered" if a receipt came first). */
export function resolvePending(chats: Chat[], clientId: string, saved: ChatMessage): Chat[] {
  return updateMessage(chats, clientId, (m) => ({
    ...saved, peer: undefined, from_me: true, client_id: clientId,
    status: bestStatus(m.status === "failed" ? "sending" : m.status, saved.status ?? "sent"), error: undefined, audio_uri: undefined,
  }));
}

export function setStatus(chats: Chat[], clientId: string, status: DeliveryStatus, error?: string): Chat[] {
  return updateMessage(chats, clientId, (m) => ({ ...m, status, error }));
}

/** My messages the server has saved but the other person hasn't received yet: ask for their receipts. */
export function awaitingReceipt(chats: Chat[]): number[] {
  const ids: number[] = [];
  for (const c of chats) for (const m of c.messages) if (m.from_me && m.status === "sent" && typeof m.id === "number") ids.push(m.id);
  return ids.slice(-500);
}

export function applyReceipts(chats: Chat[], delivered: { id: number }[]): Chat[] {
  if (!delivered.length) return chats;
  const done = new Set(delivered.map((d) => d.id));
  return chats.map((c) => (c.messages.some((m) => m.from_me && done.has(m.id as number))
    ? { ...c, messages: c.messages.map((m) => (m.from_me && done.has(m.id as number) ? { ...m, status: "delivered" as const } : m)) }
    : c));
}

/** Messages still "sending" (e.g. the app was closed mid-send): resend on start, or fail them if they can't be. */
export function unsent(chats: Chat[]): ChatMessage[] {
  return chats.flatMap((c) => c.messages.filter((m) => m.from_me && m.status === "sending"));
}

/** Waits before each retry: 1 s, 2 s, 4 s, 8 s, 16 s (with a little jitter), then give up. */
export const sendDelays = [1000, 2000, 4000, 8000, 16000];
export function retryDelay(attempt: number): number | null {
  const base = sendDelays[attempt];
  return base == null ? null : Math.round(base * (0.8 + Math.random() * 0.4));
}

/** Whether trying again might help: no connection, timeouts, server errors, too many requests. */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  return err.status === 0 || err.status === 408 || err.status === 429 || err.status >= 500;
}

/** Sends with retries. `attempt` is called with the same client id each time, so retries are safe. */
export async function sendWithRetry<T>(attempt: () => Promise<T>, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      const wait = isRetryable(err) ? retryDelay(i) : null;
      if (wait == null) throw err;
      await sleep(wait);
    }
  }
}

/* ---------- Other ---------- */

/** @deprecated kept for older callers: use addPending/resolvePending. */
export function addSent(chats: Chat[], m: ChatMessage): Chat[] {
  return addPending(chats, m);
}

export function markRead(chats: Chat[], id: string): Chat[] {
  return chats.map((c) => (c.id === id ? { ...c, unread: 0 } : c));
}

export function markEnded(chats: Chat[], id: string): Chat[] {
  return chats.map((c) => (c.id === id ? { ...c, ended: true } : c));
}

function sortChats(chats: Chat[]): Chat[] {
  return chats.sort((a, b) => Number(a.ended) - Number(b.ended) || b.updatedAt - a.updatedAt);
}

/** "bolverse://connect?t=..." from a QR code, or null if the scanned code isn't a Bolverse invite. */
export function inviteToken(scanned: string): string | null {
  const m = /^bolverse:\/\/connect\?t=([A-Za-z0-9_-]{10,})$/.exec(scanned.trim());
  return m ? m[1] : null;
}
