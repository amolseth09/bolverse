import { useMemo, useState } from "react";
import { dayLabel, findLang, type Thread } from "@bolverse/shared";
import { BotAvatar, Icon } from "../components/Brand";
import { useApi } from "../lib/api";
import { speak } from "../lib/audio";
import { useHistory } from "../lib/history";

/** Past conversations, stored only in this browser. */
export function History({ owner, rate, onContinue }: { owner: string; rate: number; onContinue: (t: Thread) => void }) {
  const { threads, remove, clear } = useHistory(owner);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const open = threads.find((t) => t.id === openId) ?? null;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter((t) => JSON.stringify(t.messages).toLowerCase().includes(q) || t.title.toLowerCase().includes(q));
  }, [threads, query]);

  if (open) return <ThreadView thread={open} rate={rate} onBack={() => setOpenId(null)} onContinue={() => onContinue(open)}
    onDelete={() => { remove(open.id); setOpenId(null); }} />;

  let lastDay = "";
  return (
    <div className="screen page">
      <h1>History</h1>
      <p className="lead">Your conversations are saved only on this device. Nothing is kept on Bolverse's servers.</p>
      {threads.length > 0 && (
        <input className="search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your conversations" aria-label="Search history" />
      )}
      {threads.length === 0 && (
        <div className="empty-state"><BotAvatar size={56} /><p>Nothing here yet. Your Ask and Converse chats will appear here.</p></div>
      )}
      <ul className="thread-list">
        {shown.map((t) => {
          const day = dayLabel(t.updatedAt);
          const header = day !== lastDay ? (lastDay = day) : null;
          return (
            <li key={t.id}>
              {header && <div className="day-label">{header}</div>}
              <button className="thread-row" onClick={() => setOpenId(t.id)}>
                <span className={"thread-kind " + t.kind}>{t.kind === "ask" ? Icon.sparkle : Icon.chat}</span>
                <span className="thread-main">
                  <span className="thread-title" dir="auto">{t.title || "Conversation"}</span>
                  <span className="thread-meta">{t.kind === "ask" ? "Ask" : "Converse"}: {findLang(t.source).name} to {findLang(t.target).name}, {t.messages.length} {t.messages.length === 1 ? "message" : "messages"}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {threads.length > 0 && (
        <button className="btn ghost danger-text" onClick={() => { if (confirm("Delete all conversations on this device?")) clear(); }}>{Icon.trash} Clear all history</button>
      )}
    </div>
  );
}

function ThreadView({ thread, rate, onBack, onContinue, onDelete }: {
  thread: Thread; rate: number; onBack: () => void; onContinue: () => void; onDelete: () => void;
}) {
  const api = useApi();
  return (
    <div className="screen page">
      <div className="row-actions top">
        <button className="btn ghost" onClick={onBack}>{Icon.back} History</button>
        {thread.kind === "ask" && <button className="btn primary" onClick={onContinue}>Continue this chat</button>}
        <button className="btn ghost danger-text" onClick={() => { if (confirm("Delete this conversation?")) onDelete(); }}>{Icon.trash} Delete</button>
      </div>
      <h2 dir="auto">{thread.title || "Conversation"}</h2>
      <p className="small muted">{new Date(thread.createdAt).toLocaleString()}</p>
      <div className="history-view">
        {thread.kind === "ask" ? thread.messages.map((m) => m.role === "user" ? (
          <div key={m.id} className="msg user"><div className="bubble user-bubble" dir="auto">{m.text}</div></div>
        ) : m.result ? (
          <div key={m.id} className="msg bot">
            <BotAvatar size={28} />
            <div className="bubble bot-bubble answer">
              <div className="answer-lang">{findLang(m.result.target).name}</div>
              <div className="answer-text" dir="auto">{m.result.translation}</div>
              {m.result.native_reading && <div className="reading"><span dir="auto">{m.result.native_reading}</span></div>}
              {m.result.english_reading && <div className="reading"><span>{m.result.english_reading}</span></div>}
              <div className="answer-actions">
                <button className="btn ghost small-btn" onClick={() => void speak(api, m.result!.translation, m.result!.target, rate, m.result!.voice_gender)}>{Icon.speaker} Play</button>
              </div>
            </div>
          </div>
        ) : null) : thread.messages.map((m) => (
          <div key={m.id} className={"bubble " + m.who}>
            <div className="said" dir="auto">{m.original}</div>
            <div className="row">
              <div><div className="tr" dir="auto">{m.translation}</div>{m.romanized && <div className="rom">{m.romanized}</div>}</div>
              <button className="iconbtn" aria-label="Play" onClick={() => void speak(api, m.translation, m.to, rate, m.gender)}>{Icon.speaker}</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
