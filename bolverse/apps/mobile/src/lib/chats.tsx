import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  addPending, ApiError, applyReceipts, awaitingReceipt, markEnded, markRead, mergeInbox, newClientId, pendingMessage,
  resolvePending, sendWithRetry, setStatus, syncConnections, unsent, type AudioUpload, type Chat, type ChatMessage,
} from "@bolverse/shared";
import { errorText, useApi } from "./api";
import { speak } from "./audio";
import { currentChatId, registerPush, setCurrentChat, setupNotifications, showLocal } from "./notify";

const POLL_MS = 3000;
const key = (owner: string) => `bolverse.chats.${owner}`;

async function load(owner: string): Promise<Chat[]> {
  try { return JSON.parse((await AsyncStorage.getItem(key(owner))) || "[]"); } catch { return []; }
}
/** Resolves true once the chats are on disk (only then may the server be told they're saved). */
function save(owner: string, chats: Chat[]): Promise<boolean> {
  return AsyncStorage.setItem(key(owner), JSON.stringify(chats.map((c) => ({ ...c, messages: c.messages.slice(-300) }))))
    .then(() => true, () => false);
}

type SendInput = { text: string } | { audio: AudioUpload };

interface ChatsCtx {
  chats: Chat[];
  unread: number;
  openId: string | null;
  setOpenId: (id: string | null) => void;
  refresh: () => Promise<void>;
  /** Sends with retries. Resolves to an ApiError the screen should react to (quota, disconnected), or null. */
  send: (connectionId: string, input: SendInput, lang: string) => Promise<ApiError | null>;
  retry: (clientId: string) => Promise<ApiError | null>;
  ended: (id: string) => void;
  remove: (id: string) => void;
}
const Ctx = createContext<ChatsCtx | null>(null);
export function useChats(): ChatsCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useChats outside ChatsProvider");
  return c;
}

/**
 * While Bolverse is open: collects messages every few seconds, saves them on this phone and only then
 * confirms them to the server, sends with retries (sending / sent / delivered / failed), reads new
 * messages aloud and shows a banner if you're elsewhere.
 */
export function ChatsProvider({ owner, enabled = true, rate, readAloud, children }: {
  owner: string; enabled?: boolean; rate: number; readAloud: boolean; children: ReactNode;
}) {
  const api = useApi();
  const [chats, setChats] = useState<Chat[]>([]);
  const [openId, setOpenIdState] = useState<string | null>(null);
  const chatsRef = useRef<Chat[]>([]);
  const busy = useRef(false);
  const loaded = useRef(false);
  const settings = useRef({ rate, readAloud });
  settings.current = { rate, readAloud };

  const update = useCallback((next: Chat[]) => { chatsRef.current = next; setChats(next); return save(owner, next); }, [owner]);
  const apply = useCallback((fn: (c: Chat[]) => Chat[]) => update(fn(chatsRef.current)), [update]);

  const deliver = useCallback(async (connectionId: string, clientId: string, input: SendInput): Promise<ApiError | null> => {
    void apply((c) => setStatus(c, clientId, "sending"));
    try {
      const saved = await sendWithRetry(() => api.connectSend(connectionId, input, clientId));
      void apply((c) => resolvePending(c, clientId, saved));
      return null;
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(0, errorText(e), "offline");
      void apply((c) => setStatus(c, clientId, "failed", err.message));
      if (err.code === "disconnected") void apply((c) => markEnded(c, connectionId));
      return err;
    }
  }, [api, apply]);

  const send = useCallback(async (connectionId: string, input: SendInput, lang: string) => {
    const clientId = newClientId();
    const audioUri = "audio" in input && !(typeof Blob !== "undefined" && input.audio instanceof Blob)
      ? (input.audio as { uri: string }).uri : undefined;
    await apply((c) => addPending(c, pendingMessage(connectionId, clientId, "text" in input ? { text: input.text } : { audioUri }, lang)));
    return deliver(connectionId, clientId, input);
  }, [apply, deliver]);

  const retry = useCallback(async (clientId: string) => {
    const msg = chatsRef.current.flatMap((c) => c.messages).find((m) => m.client_id === clientId);
    if (!msg) return null;
    if (msg.kind === "voice") {
      if (!msg.audio_uri) {
        void apply((c) => setStatus(c, clientId, "failed", "This recording is no longer available. Record it again."));
        return null;
      }
      return deliver(msg.connection_id, clientId, { audio: { uri: msg.audio_uri, name: "speech.m4a", type: "audio/m4a" } });
    }
    return deliver(msg.connection_id, clientId, { text: msg.original });
  }, [apply, deliver]);

  useEffect(() => {
    loaded.current = false;
    void load(owner).then((c) => {
      chatsRef.current = c; setChats(c); loaded.current = true; void refresh();
      // Messages left "sending" when the app was closed: send them now (the recording file is still there).
      for (const m of unsent(c)) if (m.client_id) void retry(m.client_id);
    });
    if (enabled) void setupNotifications().then((ok) => { if (ok) void registerPush(api); });
  }, [owner]);

  const refresh = useCallback(async () => {
    if (busy.current || !loaded.current || !enabled) return;
    busy.current = true;
    try {
      const [{ messages }, live] = await Promise.all([api.inbox(), api.connections()]);
      const merged = mergeInbox(syncConnections(chatsRef.current, live), messages);
      let next = merged.chats;
      if (currentChatId) next = markRead(next, currentChatId);
      const saved = await update(next);
      // Confirm only what is safely on disk; anything else is offered again next time.
      if (messages.length && saved) await api.ack(messages.map((m) => m.id));
      for (const m of merged.fresh) announce(m, next);
      const waiting = awaitingReceipt(chatsRef.current);
      if (waiting.length) {
        const { delivered } = await api.receipts(waiting);
        if (delivered.length) void apply((c) => applyReceipts(c, delivered));
      }
    } catch { /* offline: next round */ }
    busy.current = false;
  }, [api, update, apply, enabled]);

  function announce(m: ChatMessage, list: Chat[]) {
    if (m.from_me) return; // my own message, synced from my other device
    const name = list.find((c) => c.id === m.connection_id)?.peer.name ?? "Someone";
    const isMsg = m.kind === "text" || m.kind === "voice";
    const body = m.kind === "joined" ? `${name} connected with you.` : m.kind === "ended" ? `${name} disconnected.` : m.translation;
    if (m.connection_id !== currentChatId || AppState.currentState !== "active") void showLocal(isMsg ? name : "Bolverse", body, m.connection_id);
    if (settings.current.readAloud && isMsg && m.translation && AppState.currentState === "active") {
      void speak(api, m.translation, m.target, settings.current.rate, m.gender);
    }
  }

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!timer) timer = setInterval(() => void refresh(), POLL_MS); void refresh(); };
    const stop = () => { if (timer) clearInterval(timer); timer = null; };
    if (AppState.currentState === "active") start();
    const sub = AppState.addEventListener("change", (s) => (s === "active" ? start() : stop()));
    return () => { stop(); sub.remove(); };
  }, [refresh]);

  const setOpenId = useCallback((id: string | null) => {
    setCurrentChat(id);
    setOpenIdState(id);
    if (id) void apply((c) => markRead(c, id));
  }, [apply]);

  const value: ChatsCtx = {
    chats, openId, setOpenId, refresh, send, retry,
    unread: chats.reduce((n, c) => n + c.unread, 0),
    ended: (id) => void apply((c) => markEnded(c, id)),
    remove: (id) => void apply((c) => c.filter((x) => x.id !== id)),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
