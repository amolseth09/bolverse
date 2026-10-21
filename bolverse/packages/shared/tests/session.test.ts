import { test } from "node:test";
import assert from "node:assert/strict";
import { createApi, createSessionStore, parseTokens, type Tokens } from "../src/index";

type Call = { url: string; auth?: string; body?: string };

function fakeServer(handler: (c: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  (globalThis as { fetch: unknown }).fetch = async (url: string, init: RequestInit = {}) => {
    const h = (init.headers ?? {}) as Record<string, string>;
    const call = { url, auth: h["Authorization"], body: init.body as string | undefined };
    calls.push(call);
    const { status, body } = handler(call);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return calls;
}

const ME = { user: null, plan: "guest", subscription: null, usage: { today: 0, daily_limit: 50, resets_at: null }, prices: [] };

test("an expired access token is refreshed once and the request retried", async () => {
  let saved: Tokens | null = null;
  const session = createSessionStore({ access: "old", refresh: "r1" }, (t) => { saved = t; });
  const calls = fakeServer((c) => {
    if (c.url.endsWith("/auth/refresh")) return { status: 200, body: { access_token: "new", refresh_token: "r2" } };
    return c.auth === "Bearer new" ? { status: 200, body: ME } : { status: 401, body: { detail: { code: "token_expired" } } };
  });
  const api = createApi({ baseUrl: "https://x.test", deviceId: "dev12345", session });
  const [a, b] = await Promise.all([api.me(), api.me()]);
  assert.equal(a.plan, "guest");
  assert.equal(b.plan, "guest");
  assert.equal(calls.filter((c) => c.url.endsWith("/auth/refresh")).length, 1, "one refresh for both requests");
  assert.deepEqual(saved, { access: "new", refresh: "r2" });
});

test("a refused refresh signs out", async () => {
  const session = createSessionStore({ access: "old", refresh: "stolen" }, () => {});
  fakeServer((c) => c.url.endsWith("/auth/refresh")
    ? { status: 401, body: { detail: { code: "session_expired" } } }
    : { status: 401, body: { detail: { code: "token_expired" } } });
  const api = createApi({ baseUrl: "https://x.test", deviceId: "dev12345", session });
  await assert.rejects(api.me(), (e: { code?: string }) => e.code === "session_expired");
  assert.equal(session.get(), null);
});

test("offline during refresh keeps the tokens", async () => {
  const session = createSessionStore({ access: "old", refresh: "r1" }, () => {});
  (globalThis as { fetch: unknown }).fetch = async (url: string) => {
    if (url.endsWith("/auth/refresh")) throw new TypeError("network");
    return new Response(JSON.stringify({ detail: { code: "token_expired" } }), { status: 401 });
  };
  const api = createApi({ baseUrl: "https://x.test", deviceId: "dev12345", session });
  await assert.rejects(api.me());
  assert.deepEqual(session.get(), { access: "old", refresh: "r1" });
});

test("tokens saved by older versions still load", () => {
  assert.deepEqual(parseTokens('{"access":"a","refresh":"b"}'), { access: "a", refresh: "b" });
  assert.deepEqual(parseTokens("legacy-token"), { access: "legacy-token", refresh: "" });
  assert.equal(parseTokens(null), null);
});
