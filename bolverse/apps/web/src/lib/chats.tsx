import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  addPending, ApiError, applyReceipts, awaitingReceipt, markEnded, markRead, mergeInbox, newClientId, pendingMessage,
  resolvePending, sendWithRetry, setStatus, syncConnections, unsent, type Chat, type ChatMessage,
} from "@bolverse/shared";
import { errorText, useApi } from "./api";
import { speak } from "./audio";

const POLL_MS = 3000;
const key = (owner: string) => `bolverse.chats.${owner}`;

function load(owner: string): Chat[] {
  try { return JSON.parse(localStorage.getItem(key(owner)) || "[]"); } catch { return []; }
}
/** Returns false if the browser refused to save (storage full or blocked): then we must not confirm. */
function save(owner: string, chats: Chat[]): boolean {
  try {
    localStorage.setItem(key(owner), JSON.stringify(chats.map((c) => ({ ...c, messages: c.messages.slice(-300) }))));
    return true;
  } catch { return false; }
}

type SendInput = { text: string } | { audio: Blob };

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
 * Collects messages every few seconds while Bolverse is open, saves them in this browser and only then
 * confirms them to the server, sends with retries, tracks sending / sent / delivered / failed, reads new
 * messages aloud and shows a notification when the tab is in the background.
 */
export function ChatsProvider({ owner, enabled = true, rate, readAloud, children }: {
  owner: string; enabled?: boolean; rate: number; readAloud: boolean; children: ReactNode;
}) {
  const api = useApi();
  const [chats, setChats] = useState<Chat[]>(() => load(owner));
  const [openId, setOpenIdState] = useState<string | null>(null);
  const openRef = useRef<string | null>(null);
  const busy = useRef(false);
  const chatsRef = useRef(chats);
  const recordings = useRef(new Map<string, Blob>()); // voice messages kept in memory for Retry
  chatsRef.current = chats;

  const update = useCallback((next: Chat[]): boolean => { chatsRef.current = next; setChats(next); return save(owner, next); }, [owner]);
  const apply = useCallback((fn: (c: Chat[]) => Chat[]) => update(fn(chatsRef.current)), [update]);

  const refresh = useCallback(async () => {
    if (busy.current || !enabled) return;
    busy.current = true;
    try {
      const [{ messages }, live] = await Promise.all([api.inbox(), api.connections()]);
      const merged = mergeInbox(syncConnections(chatsRef.current, live), messages);
      let next = merged.chats;
      if (openRef.current) next = markRead(next, openRef.current);
      const saved = update(next);
      // Confirm only what is safely stored; anything else is offered again next time.
      if (messages.length && saved) await api.ack(messages.map((m) => m.id));
      for (const m of merged.fresh) announce(m, next);
      const waiting = awaitingReceipt(chatsRef.current);
      if (waiting.length) {
        const { delivered } = await api.receipts(waiting);
        if (delivered.length) apply((c) => applyReceipts(c, delivered));
      }
    } catch { /* offline: try again next time */ }
    busy.current = false;
  }, [api, update, apply, enabled]);

  function announce(m: ChatMessage, list: Chat[]) {
    if (m.from_me) return; // my own message, synced from my other device
    const chat = list.find((c) => c.id === m.connection_id);
    const name = chat?.peer.name ?? "Someone";
    const text = m.kind === "joined" ? `${name} connected with you.` : m.kind === "ended" ? `${name} disconnected.` : m.translation;
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      try { new Notification(m.kind === "text" || m.kind === "voice" ? name : "Bolverse", { body: text, tag: m.connection_id }); } catch { /* not allowed here */ }
    }
    if (readAloud && (m.kind === "text" || m.kind === "voice") && m.translation) {
      void speak(api, m.translation, m.target, rate, m.gender);
    }
  }

  const deliver = useCallback(async (connectionId: string, clientId: string, input: SendInput): Promise<ApiError | null> => {
    apply((c) => setStatus(c, clientId, "sending"));
    try {
      const saved = await sendWithRetry(() => api.connectSend(connectionId, input, clientId));
      recordings.current.delete(clientId);
      apply((c) => resolvePending(c, clientId, saved));
      return null;
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(0, errorText(e), "offline");
      apply((c) => setStatus(c, clientId, "failed", err.message));
      if (err.code === "disconnected") apply((c) => markEnded(c, connectionId));
      return err;
    }
  }, [api, apply]);

  const send = useCallback(async (connectionId: string, input: SendInput, lang: string) => {
    const clientId = newClientId();
    if ("audio" in input) recordings.current.set(clientId, input.audio);
    apply((c) => addPending(c, pendingMessage(connectionId, clientId, "text" in input ? { text: input.text } : {}, lang)));
    return deliver(connectionId, clientId, input);
  }, [apply, deliver]);

  const retry = useCallback(async (clientId: string) => {
    const msg = chatsRef.current.flatMap((c) => c.messages).find((m) => m.client_id === clientId);
    if (!msg) return null;
    if (msg.kind === "voice") {
      const audio = recordings.current.get(clientId);
      if (!audio) {
        apply((c) => setStatus(c, clientId, "failed", "This recording is no longer available. Record it again."));
        return null;
      }
      return deliver(msg.connection_id, clientId, { audio });
    }
    return deliver(msg.connection_id, clientId, { text: msg.original });
  }, [apply, deliver]);

  useEffect(() => {
    const restored = load(owner);
    update(restored);
    // Messages left "sending" when the page was closed: resend text; recordings didn't survive the reload.
    for (const m of unsent(restored)) {
      if (m.kind === "text" && m.client_id) void deliver(m.connection_id, m.client_id, { text: m.original });
      else if (m.client_id) apply((c) => setStatus(c, m.client_id!, "failed", "Not sent. Record it again."));
    }
  }, [owner]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => { if (!document.hidden || "Notification" in window) void refresh(); }, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const setOpenId = useCallback((id: string | null) => {
    openRef.current = id;
    setOpenIdState(id);
    if (id) apply((c) => markRead(c, id));
  }, [apply]);

  const value: ChatsCtx = {
    chats, openId, setOpenId, refresh, send, retry,
    unread: chats.reduce((n, c) => n + c.unread, 0),
    ended: (id) => apply((c) => markEnded(c, id)),
    remove: (id) => apply((c) => c.filter((x) => x.id !== id)),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
