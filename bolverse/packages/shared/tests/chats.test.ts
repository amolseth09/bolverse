import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addPending, ApiError, applyReceipts, awaitingReceipt, isRetryable, mergeInbox, newClientId, pendingMessage,
  resolvePending, sendWithRetry, setStatus, unsent, type Chat, type ChatMessage,
} from "../src/index";

const peer = { id: "u2", name: "Rahul", language: "hi-IN", gender: "male" as const };
const chat = (): Chat => ({ id: "c1", peer, since: "2026-10-21T00:00:00Z", ended: false, unread: 0, messages: [], updatedAt: 0 });
const incoming = (id: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id, connection_id: "c1", kind: "text", from_me: false, original: `m${id}`, source: "hi-IN", translation: `t${id}`,
  target: "en-US", gender: "male", at: new Date(Date.UTC(2026, 9, 21, 0, 0, id)).toISOString(), peer, ...extra,
});

test("the same inbox message offered twice is stored once", () => {
  let { chats } = mergeInbox([chat()], [incoming(1)]);
  ({ chats } = mergeInbox(chats, [incoming(1)]));
  assert.equal(chats[0].messages.length, 1);
  assert.equal(chats[0].unread, 1);
});

test("a message for a chat this device doesn't know creates the chat instead of being dropped", () => {
  const { chats, fresh } = mergeInbox([], [incoming(5, { connection_id: "c9" })]);
  assert.equal(chats[0].id, "c9");
  assert.equal(chats[0].peer.name, "Rahul");
  assert.equal(fresh.length, 1);
});

test("sending: sending -> sent -> delivered, and a synced copy doesn't duplicate", () => {
  const cid = newClientId();
  assert.match(cid, /^[A-Za-z0-9_-]{8,40}$/);
  let chats = addPending([chat()], pendingMessage("c1", cid, { text: "hello" }, "en-US"));
  assert.equal(chats[0].messages[0].status, "sending");
  assert.deepEqual(unsent(chats).map((m) => m.client_id), [cid]);
  chats = resolvePending(chats, cid, incoming(7, { from_me: true, client_id: cid, status: "sent", original: "hello" }));
  assert.equal(chats[0].messages[0].id, 7);
  assert.equal(chats[0].messages[0].status, "sent");
  assert.deepEqual(awaitingReceipt(chats), [7]);
  ({ chats } = mergeInbox(chats, [incoming(7, { from_me: true, client_id: cid, status: "sent" })]));
  assert.equal(chats[0].messages.length, 1);
  chats = applyReceipts(chats, [{ id: 7 }]);
  assert.equal(chats[0].messages[0].status, "delivered");
  assert.deepEqual(awaitingReceipt(chats), []);
});

test("failed messages keep their error until retried", () => {
  const cid = newClientId();
  let chats = addPending([chat()], pendingMessage("c1", cid, { text: "x" }, "en-US"));
  chats = setStatus(chats, cid, "failed", "No internet");
  assert.equal(chats[0].messages[0].status, "failed");
  assert.equal(chats[0].messages[0].error, "No internet");
  assert.equal(unsent(chats).length, 0);
});

test("retry rules: network and server errors retry, quota and disconnect don't", () => {
  assert.equal(isRetryable(new ApiError(0, "offline", "offline")), true);
  assert.equal(isRetryable(new ApiError(503, "busy")), true);
  assert.equal(isRetryable(new ApiError(402, "quota", "quota_exceeded")), false);
  assert.equal(isRetryable(new ApiError(409, "gone", "disconnected")), false);
});

test("sendWithRetry backs off, then succeeds with the same attempt function", async () => {
  let calls = 0;
  const waits: number[] = [];
  const out = await sendWithRetry(async () => {
    calls++;
    if (calls < 3) throw new ApiError(0, "offline", "offline");
    return "ok";
  }, async (ms) => { waits.push(ms); });
  assert.equal(out, "ok");
  assert.equal(calls, 3);
  assert.equal(waits.length, 2);
  assert.ok(waits[1] > waits[0] * 1.2);
});

test("sendWithRetry gives up after five retries", async () => {
  let calls = 0;
  await assert.rejects(sendWithRetry(async () => { calls++; throw new ApiError(500, "boom"); }, async () => {}));
  assert.equal(calls, 6);
});
