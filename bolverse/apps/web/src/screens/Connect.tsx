import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { dayLabel, findLang, qrMatrix, qrPath, type Chat, type ChatMessage, type Invite } from "@bolverse/shared";
import { BotAvatar, Icon } from "../components/Brand";
import { Sheet } from "../components/Sheet";
import { errorText, useApi } from "../lib/api";
import { useAccount } from "../lib/account";
import { micErrorMessage, Recorder, speak, stopSpeaking } from "../lib/audio";
import { useChats } from "../lib/chats";

const MAX_SECONDS = 30;

/** Connect: chat with someone on their own phone. Each of you speaks your own language. */
export function Connect({ rate }: { rate: number }) {
  const { account, openLogin } = useAccount();
  const { chats, openId, setOpenId } = useChats();
  if (!account.user) {
    return (
      <div className="screen page connect">
        <h1>Connect</h1>
        <p className="lead">Chat with someone on their own phone, each in your own language. Bolverse AI translates both ways.</p>
        <div className="empty-state"><BotAvatar size={52} /><p>Log in with your mobile number to connect with people.</p>
          <button className="btn primary" onClick={() => openLogin()}>Log in or sign up</button></div>
      </div>
    );
  }
  const open = chats.find((c) => c.id === openId) ?? null;
  return open ? <ChatView chat={open} rate={rate} onBack={() => setOpenId(null)} /> : <ChatList chats={chats} onOpen={setOpenId} />;
}

function ChatList({ chats, onOpen }: { chats: Chat[]; onOpen: (id: string) => void }) {
  const api = useApi();
  const { refresh, remove } = useChats();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notify, setNotify] = useState(() => ("Notification" in window ? Notification.permission : "denied"));

  async function showQr() {
    setError(""); setBusy(true);
    try { setInvite(await api.connectInvite()); } catch (e) { setError(errorText(e)); }
    setBusy(false);
  }
  async function join(e: FormEvent) {
    e.preventDefault();
    const c = code.trim().replace(/\s/g, "");
    if (c.length < 6) { setError("Type the 6-character code under their QR."); return; }
    setError(""); setBusy(true);
    try {
      const r = await api.connectJoin({ code: c });
      setCode("");
      await refresh();
      onOpen(r.connection.id);
    } catch (x) { setError(errorText(x)); }
    setBusy(false);
  }

  return (
    <div className="screen page connect">
      <h1>Connect</h1>
      <p className="lead">Chat with someone on their own phone. You each speak your language; Bolverse AI translates both ways and reads it aloud.</p>
      <div className="connect-hero">
        <button className="connect-tile primary" onClick={() => void showQr()} disabled={busy}>
          <span className="tile-icon">{Icon.qr}</span>
          <span className="tile-text"><b>Show my QR code</b><span>They scan it to connect</span></span>
        </button>
        <form className="connect-tile code" onSubmit={join}>
          <span className="tile-icon">{Icon.link}</span>
          <span className="tile-text"><b>Have a code?</b>
            <span className="code-join">
              <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={8} placeholder="6-letter code"
                aria-label="Code under the other person's QR" autoCapitalize="characters" spellCheck={false} />
              <button className="btn primary small-btn" disabled={busy}>Join</button>
            </span>
          </span>
        </form>
      </div>
      <p className="small muted">On a phone, the other person can open Bolverse and tap <b>Scan QR</b>.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {notify === "default" && (
        <p className="notice">Get a notification when a message arrives while this tab is in the background.{" "}
          <button className="linkbtn" onClick={() => void Notification.requestPermission().then(setNotify)}>Turn on notifications</button></p>
      )}

      <h2>Your chats</h2>
      {chats.length === 0 && <div className="empty-state"><BotAvatar size={52} /><p className="muted">No chats yet. Show your QR code to a friend with Bolverse and start talking in your own languages.</p></div>}
      <ul className="chat-list">
        {chats.map((c) => {
          const last = [...c.messages].reverse().find((m) => m.kind === "text" || m.kind === "voice");
          return (
            <li key={c.id}>
              <button className={"chat-row" + (c.ended ? " ended" : "")} onClick={() => onOpen(c.id)}>
                <span className="avatar-letter">{c.peer.name.slice(0, 1)}</span>
                <span className="chat-row-text">
                  <b>{c.peer.name}</b>
                  <span className="small muted">{c.ended ? "Disconnected" : findLang(c.peer.language).name}{last ? ` · ${last.from_me ? "You: " + last.original : last.translation}` : ""}</span>
                </span>
                {c.unread > 0 && <span className="unread" aria-label={`${c.unread} unread`}>{c.unread}</span>}
              </button>
              {c.ended && <button className="iconbtn" aria-label={`Delete chat with ${c.peer.name}`} onClick={() => confirm(`Delete your chat with ${c.peer.name} from this browser?`) && remove(c.id)}>{Icon.trash}</button>}
            </li>
          );
        })}
      </ul>
      {invite && <QrSheet invite={invite} onNew={() => void showQr()} onClose={() => setInvite(null)} />}
    </div>
  );
}

function QrSheet({ invite, onNew, onClose }: { invite: Invite; onNew: () => void; onClose: () => void }) {
  const { chats, refresh } = useChats();
  const [left, setLeft] = useState(invite.expires_in);
  const known = useRef(new Set(chats.map((c) => c.id)));
  const matrix = useMemo(() => qrMatrix(invite.qr), [invite.qr]);
  useEffect(() => {
    setLeft(invite.expires_in);
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    const p = setInterval(() => void refresh(), 2000);
    return () => { clearInterval(t); clearInterval(p); };
  }, [invite]);
  const joined = chats.find((c) => !known.current.has(c.id) && !c.ended);
  useEffect(() => { if (joined) onClose(); }, [joined]);
  const n = matrix.length;
  return (
    <Sheet title="Your QR code" onClose={onClose}>
      <div className="qr-sheet">
        <h2 className="sheet-title">Let them scan this</h2>
        <p className="muted">It works once, for {Math.ceil(invite.expires_in / 60)} minutes.</p>
        {left > 0 ? (
          <svg className="qr" viewBox={`-2 -2 ${n + 4} ${n + 4}`} role="img" aria-label="QR code to connect">
            <rect x={-2} y={-2} width={n + 4} height={n + 4} fill="#fff" />
            <path d={qrPath(matrix)} fill="#0E1120" />
          </svg>
        ) : <div className="qr expired"><p>This code has expired.</p></div>}
        <p className="invite-code">Or type: <b>{invite.code}</b></p>
        <p className="small muted" role="timer">{left > 0 ? `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "Make a new one to connect."}</p>
        <div className="row-actions" style={{ justifyContent: "center" }}>
          <button className="btn ghost" onClick={onNew}>New code</button>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </Sheet>
  );
}

function ChatView({ chat, rate, onBack }: { chat: Chat; rate: number; onBack: () => void }) {
  const api = useApi();
  const { account, openPaywall, refresh: refreshAccount } = useAccount();
  const { send: sendMessage, retry, ended } = useChats();
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const rec = useRef<Recorder | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const me = findLang(account.user?.language);
  const them = findLang(chat.peer.language);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [chat.messages.length]);
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);
  useEffect(() => { if (recording && seconds >= MAX_SECONDS) void toggleMic(); }, [seconds]);
  useEffect(() => () => rec.current?.cancel(), []);

  async function send(input: { text: string } | { audio: Blob }) {
    setError("");
    const err = await sendMessage(chat.id, input, me.code);
    void refreshAccount();
    if (err?.code === "quota_exceeded") openPaywall("translations");
  }
  async function onRetry(clientId: string) {
    const err = await retry(clientId);
    if (err?.code === "quota_exceeded") openPaywall("translations");
  }
  async function toggleMic() {
    if (recording) {
      const r = rec.current;
      rec.current = null; setRecording(false);
      if (r) void send({ audio: await r.stop() });
      return;
    }
    stopSpeaking(); setError("");
    const r = new Recorder();
    try { await r.start(); } catch (e) { setError(micErrorMessage(e)); return; }
    rec.current = r; setSeconds(0); setRecording(true);
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText("");
    void send({ text: t });
  }
  async function disconnect() {
    if (!confirm(`Disconnect from ${chat.peer.name}? To talk again, one of you will need to show a new QR code.`)) return;
    try { await api.disconnect(chat.id); } catch { /* already gone */ }
    ended(chat.id);
  }

  return (
    <div className="screen chat-screen">
      <div className="peer-head">
        <button className="iconbtn" onClick={onBack} aria-label="Back to chats">{Icon.back}</button>
        <span className="avatar-letter">{chat.peer.name.slice(0, 1)}</span>
        <div className="chat-head-text"><b>{chat.peer.name}</b><span className="small muted">{them.name} ⇄ {me.name}</span></div>
        {!chat.ended && <button className="btn ghost small-btn danger-text" onClick={() => void disconnect()} aria-label="Disconnect">{Icon.unlink}<span>Disconnect</span></button>}
      </div>
      <div className="chat-messages" ref={listRef} aria-live="polite">
        {chat.messages.map((m, i) => <Bubble key={`${m.client_id ?? m.id}-${i}`} m={m} prev={chat.messages[i - 1]} name={chat.peer.name} rate={rate} onRetry={onRetry} />)}
        {recording && <div className="bubble me interim"><div className="tr">Listening… 0:{String(seconds).padStart(2, "0")}</div></div>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {chat.ended ? (
        <p className="notice">This chat was disconnected. To talk again, one of you shows a new QR code from Connect.</p>
      ) : (
        <form className="chat-compose" onSubmit={submit}>
          <button type="button" className={"mic-btn" + (recording ? " live" : "")} onClick={() => void toggleMic()}
            aria-label={recording ? "Stop and send" : "Speak in " + me.name}>{recording ? Icon.stop : Icon.mic}</button>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Type in ${me.name}`} aria-label="Message" disabled={recording} />
          <button className="btn primary" disabled={!text.trim()} aria-label="Send">{Icon.send}</button>
        </form>
      )}
    </div>
  );
}

const STATUS_TEXT = { sending: "Sending…", sent: "Sent ✓", delivered: "Delivered ✓✓", failed: "Not sent" } as const;

function Bubble({ m, prev, name, rate, onRetry }: {
  m: ChatMessage; prev?: ChatMessage; name: string; rate: number; onRetry: (clientId: string) => void;
}) {
  const api = useApi();
  const day = dayLabel(Date.parse(m.at));
  const showDay = !prev || dayLabel(Date.parse(prev.at)) !== day;
  if (m.kind === "joined" || m.kind === "ended") {
    return <p className="chat-system">{m.kind === "joined" ? `${name} connected with you` : `${m.from_me ? "You" : name} disconnected`}</p>;
  }
  const mine = m.from_me;
  const shown = mine ? m.original : m.translation;
  const other = mine ? m.translation : m.original;
  return (
    <>
      {showDay && <p className="chat-system">{day}</p>}
      <div className={"bubble " + (mine ? "me" : "them") + (m.status === "failed" ? " failed" : "") + (m.status === "sending" ? " interim" : "")}>
        <div className="tr">{shown}</div>
        {!!other && <div className="small orig">{mine ? `They hear: ${other}` : `They said: ${other}`}</div>}
        {m.status === "failed" && m.error && <div className="small orig" role="alert">{m.error}</div>}
        <div className="bubble-foot">
          <span className="small">{m.kind === "voice" ? "🎙 " : ""}{new Date(m.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
            {mine && m.status && <span className={"msg-status " + m.status} aria-live="polite"> · {STATUS_TEXT[m.status]}</span>}</span>
          {mine && m.status === "failed" && m.client_id && <button className="btn small-btn retry-btn" onClick={() => onRetry(m.client_id!)}>Retry</button>}
          {!mine && <button className="iconbtn" aria-label="Play again" onClick={() => void speak(api, m.translation, m.target, rate, m.gender)}>{Icon.speaker}</button>}
        </div>
      </div>
    </>
  );
}
