import type {
  Account, AskResult, ChatMessage, Checkout, ConnectionInfo, ConverseResult, Health, Invite, NewUserDetails, OtpSent,
  PassPlan, PayMethod, SignedIn, Tokens, TranslateResult, VerifyResult, VoiceGender,
} from "./types";

/**
 * Where an app keeps its tokens (web: localStorage, phone: Keychain/Keystore). The API client reads the
 * current tokens on every request and writes new ones after a refresh, so one store serves every request.
 */
export interface SessionStore {
  get(): Tokens | null;
  set(tokens: Tokens | null): void;
  /** Called when the store changes (sign in, refresh, sign out). Returns an unsubscribe function. */
  subscribe(fn: (tokens: Tokens | null) => void): () => void;
}

export function createSessionStore(initial: Tokens | null, persist: (t: Tokens | null) => void,
  reload?: () => Tokens | null): SessionStore {
  let current = initial;
  const listeners = new Set<(t: Tokens | null) => void>();
  return {
    get: () => (reload ? (current = reload() ?? current) : current),
    set(t) { current = t; persist(t); listeners.forEach((fn) => fn(t)); },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}

/** Reads tokens saved by any app version: JSON {access, refresh}, or a bare token from before 1.2. */
export function parseTokens(raw: string | null | undefined): Tokens | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw);
    if (t && typeof t.access === "string") return { access: t.access, refresh: typeof t.refresh === "string" ? t.refresh : "" };
  } catch { /* an old single token */ }
  return { access: raw, refresh: "" };
}

export function tokensFrom(signedIn: SignedIn): Tokens {
  return { access: signedIn.access_token ?? signedIn.token, refresh: signedIn.refresh_token ?? "" };
}

/** A browser Blob, or a React Native file descriptor { uri, name, type }. */
export type AudioUpload = Blob | { uri: string; name: string; type: string };

export class ApiError extends Error {
  /** Machine-readable reason from the server, e.g. quota_exceeded, premium_required, otp_invalid. */
  code?: string;
  /** Extra fields sent with the error, e.g. { feature: "tutor" }. */
  info: Record<string, unknown>;
  constructor(public status: number, message: string, code?: string, info: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.info = info;
  }
}

export interface ApiConfig {
  baseUrl: string;
  apiKey?: string;
  /** Required: identifies this install (guest limits follow it). */
  deviceId: string;
  /** Session token after login (fixed). Prefer `session`, which refreshes itself. */
  token?: string | null;
  /** Tokens that refresh automatically when the access token expires. */
  session?: SessionStore;
  /** Country code like "IN", used to show prices before sign-in. */
  region?: string;
}

/**
 * Completes a server address typed without a scheme: "my.ngrok-free.dev" -> "https://my.ngrok-free.dev".
 * Local addresses (localhost, 127.x, 192.168.x, 10.x, 172.16-31.x) get http:// since they rarely have HTTPS.
 */
export function normalizeServerUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (!url) return url;
  if (!/^https?:\/\//i.test(url)) {
    const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url);
    url = (local ? "http://" : "https://") + url.replace(/^\/+/, "");
  }
  return url;
}

export function createApi({ baseUrl, apiKey, deviceId, token, session, region }: ApiConfig) {
  const base = normalizeServerUrl(baseUrl);
  // The ngrok header skips its free-plan browser warning page; other hosts ignore it.
  const fixed: Record<string, string> = { "X-Device-Id": deviceId, "ngrok-skip-browser-warning": "1" };
  if (apiKey) fixed["X-API-Key"] = apiKey;
  if (region) fixed["X-Region"] = region;
  const accessToken = () => session?.get()?.access ?? token ?? null;
  const headers = (): Record<string, string> => {
    const t = accessToken();
    return t ? { ...fixed, Authorization: `Bearer ${t}` } : { ...fixed };
  };

  let refreshing: Promise<boolean> | null = null;
  /** One refresh at a time; every request that hit an expired token waits for the same one. */
  function refreshTokens(): Promise<boolean> {
    if (!session) return Promise.resolve(false);
    if (!refreshing) {
      refreshing = (async () => {
        const current = session.get();
        if (!current?.refresh) { session.set(null); return false; }
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await fetch(base + "/auth/refresh", {
              method: "POST", headers: { ...fixed, "Content-Type": "application/json" },
              body: JSON.stringify({ refresh_token: session.get()?.refresh ?? current.refresh }),
            });
            if (res.ok) {
              const body = await res.json();
              session.set({ access: body.access_token, refresh: body.refresh_token });
              return true;
            }
            if (res.status === 409) { await new Promise((r) => setTimeout(r, 400)); continue; } // another tab refreshed
            if (res.status === 401) { session.set(null); return false; }
            return false; // server trouble: keep the tokens, try again on the next request
          } catch {
            return false; // offline: keep the tokens
          }
        }
        return !!session.get()?.access && session.get()?.access !== current.access;
      })().finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  async function request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
    let res: Response;
    try {
      res = await fetch(base + path, { ...init, headers: { ...headers(), ...(init.headers as Record<string, string>) } });
    } catch {
      throw new ApiError(0, "Can't reach Bolverse right now. Check your internet connection and try again.", "offline");
    }
    if (!res.ok) {
      let message = `The server answered with an error (${res.status}).`;
      let code: string | undefined;
      let info: Record<string, unknown> = {};
      try {
        const detail = (await res.json())?.detail;
        if (typeof detail === "string") message = detail;
        else if (Array.isArray(detail)) message = "Some details aren't valid. Check them and try again.";
        else if (detail && typeof detail === "object") {
          ({ code, message = message, ...info } = detail as { code?: string; message?: string });
        }
      } catch { /* not JSON */ }
      if (res.status === 401 && code === "token_expired" && !retried && (await refreshTokens())) {
        return request<T>(path, init, true);
      }
      if (res.status === 401 && code === "token_expired") code = "session_expired";
      throw new ApiError(res.status, message, code, info);
    }
    return res.json() as Promise<T>;
  }

  const json = (path: string, body: unknown) =>
    ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as RequestInit;

  function upload(audio: AudioUpload, fields: Record<string, string>): FormData {
    const fd = new FormData();
    if (typeof Blob !== "undefined" && audio instanceof Blob) {
      const ext = audio.type.includes("mp4") ? "m4a" : audio.type.includes("ogg") ? "ogg" : "webm";
      fd.append("audio", audio, `speech.${ext}`);
    } else {
      fd.append("audio", audio as unknown as Blob); // React Native reads { uri, name, type }
    }
    Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
    return fd;
  }

  const voiceCache = new Map<string, Promise<string[]>>();

  return {
    baseUrl: base,
    health: () => request<Health>("/health"),

    // Account
    me: () => request<Account>("/me"),
    updateMe: (patch: { name?: string; voice_gender?: VoiceGender; language?: string }) =>
      request<Account>("/me", { ...json("/me", patch), method: "PATCH" }),
    requestOtp: (phone: string) => request<OtpSent>("/auth/otp", json("/auth/otp", { phone })),
    verify: (phone: string, code: string) => request<VerifyResult>("/auth/verify", json("/auth/verify", { phone, code })),
    complete: (details: NewUserDetails) => request<SignedIn>("/auth/complete", json("/auth/complete", details)),
    logout: () => request<{ ok: boolean }>("/auth/logout", json("/auth/logout", { refresh_token: session?.get()?.refresh || null })),
    /** Makes sure the access token is fresh (e.g. before handing a URL to an audio player). */
    ensureFresh: () => refreshTokens(),
    checkout: (plan: PassPlan, method?: PayMethod) =>
      request<Checkout>("/billing/checkout", json("/billing/checkout", { plan, method: method ?? null })),

    // Connect: QR chat with another phone
    connectInvite: () => request<Invite>("/connect/invite", { method: "POST" }),
    /** Pass the scanned QR text (bolverse://connect?t=...) or the typed 6-character code. */
    connectJoin: (input: { token: string } | { code: string }) =>
      request<{ connection: ConnectionInfo }>("/connect/join", json("/connect/join", input)),
    connections: () => request<ConnectionInfo[]>("/connect"),
    /** Pass the same clientId when retrying: the server then returns the message it already saved. */
    connectSend(connectionId: string, input: { text: string } | { audio: AudioUpload }, clientId?: string): Promise<ChatMessage> {
      const extra: Record<string, string> = clientId ? { client_id: clientId } : {};
      const fd = "audio" in input ? upload(input.audio, extra) : (() => {
        const f = new FormData(); f.append("text", input.text); Object.entries(extra).forEach(([k, v]) => f.append(k, v)); return f;
      })();
      return request<ChatMessage>(`/connect/${connectionId}/messages`, { method: "POST", body: fd });
    },
    inbox: () => request<{ messages: ChatMessage[] }>("/connect/inbox"),
    ack: (ids: (number | string)[]) =>
      request<{ ok: boolean; acked: number[] }>("/connect/ack", json("/connect/ack", { ids: ids.filter((i) => typeof i === "number") })),
    receipts: (ids: number[]) =>
      request<{ delivered: { id: number; at: string }[] }>("/connect/receipts", json("/connect/receipts", { ids })),
    disconnect: (connectionId: string) => request<{ ok: boolean }>(`/connect/${connectionId}/disconnect`, { method: "POST" }),
    registerPush: (token: string, platform = "android") =>
      request<{ ok: boolean; enabled: boolean }>("/push/register", json("/push/register", { token, platform })),
    unregisterPush: (token: string) => request<{ ok: boolean }>("/push/unregister", json("/push/unregister", { token })),

    // Ask: speak or type; get the translation plus how to read it
    ask(source: string, target: string, input: { text: string } | { audio: AudioUpload }): Promise<AskResult> {
      const fd = "audio" in input ? upload(input.audio, { source, target }) : (() => {
        const f = new FormData(); f.append("source", source); f.append("target", target); f.append("text", input.text); return f;
      })();
      return request<AskResult>("/ask", { method: "POST", body: fd });
    },

    // Converse
    translate: (text: string, source: string, target: string, speaker: "me" | "them", speakerGender?: VoiceGender | null) =>
      request<TranslateResult>("/translate", json("/translate", { text, source, target, speaker, speaker_gender: speakerGender ?? null })),
    converse(audio: AudioUpload, source: string, target: string, speaker: "me" | "them", speakerGender?: VoiceGender | null) {
      const fields: Record<string, string> = { source, target, speaker };
      if (speakerGender) fields.speaker_gender = speakerGender;
      return request<ConverseResult>("/converse", { method: "POST", body: upload(audio, fields) });
    },

    // Voices
    /** Voice genders the server can speak for a language: ["female","male"], ["any"] or [] (cached). */
    voiceGenders(language: string): Promise<string[]> {
      if (!voiceCache.has(language)) {
        voiceCache.set(language, request<{ available: boolean; genders: string[] }>(`/voices/${encodeURIComponent(language)}`)
          .then((r) => (r.available ? r.genders : [])).catch(() => []));
      }
      return voiceCache.get(language)!;
    },
    async ttsBlob(text: string, language: string, rate = 1, gender?: VoiceGender | null): Promise<Blob | null> {
      const q = new URLSearchParams({ text, language, rate: String(rate) });
      if (gender) q.set("gender", gender);
      try {
        let res = await fetch(`${base}/tts?${q.toString()}`, { headers: headers() });
        if (res.status === 401 && (await refreshTokens())) res = await fetch(`${base}/tts?${q.toString()}`, { headers: headers() });
        const blob = res.ok ? await res.blob() : null;
        return blob && blob.type.startsWith("audio") ? blob : null;
      } catch {
        return null;
      }
    },
    /** A URL for native audio players, which can't send headers (device and session go in the query). */
    ttsUrl(text: string, language: string, rate = 1, gender?: VoiceGender | null): string {
      const q = new URLSearchParams({ text, language, rate: String(rate), device: deviceId });
      if (gender) q.set("gender", gender);
      const t = accessToken();
      if (t) q.set("session", t);
      if (apiKey) q.set("api_key", apiKey);
      return `${base}/tts?${q.toString()}`;
    },
  };
}

export type BolverseApi = ReturnType<typeof createApi>;
