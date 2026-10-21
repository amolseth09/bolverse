import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  findLang, firstName, freeLeftText, leftToday, newId, otherThan, SUGGESTIONS,
  type AskMessage, type AskResult, type Profile, type Thread, type VoiceGender,
} from "@bolverse/shared";
import { AiTag, BotAvatar, Chip, Icon, LangSelect } from "../components/Brand";
import { errorText, useApi } from "../lib/api";
import { useAccount } from "../lib/account";
import { micErrorMessage, Recorder, speak, stopSpeaking } from "../lib/audio";
import { useHistory } from "../lib/history";

type AskThread = Extract<Thread, { kind: "ask" }>;

export function Ask({ prefs, updatePrefs, owner, open }: {
  prefs: Profile; updatePrefs: (p: Partial<Profile>) => void; owner: string; open?: AskThread | null;
}) {
  const api = useApi();
  const { account, refresh, openPaywall, handleError } = useAccount();
  const { save } = useHistory(owner);
  const me = findLang(account.user?.language ?? prefs.myLang);
  const target = findLang(otherThan(me.code, prefs.askTarget));
  const voice: VoiceGender | null = account.user?.voice_gender ?? null;
  const [thread, setThread] = useState<AskThread>(() => open ?? blank());
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [notice, setNotice] = useState("");
  const rec = useRef<Recorder | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const left = leftToday(account);
  const busy = thread.messages.some((m) => m.role === "bot" && !m.result && !m.error);

  function blank(): AskThread {
    const now = Date.now();
    return { id: newId(), kind: "ask", title: "", source: me.code, target: target.code, createdAt: now, updatedAt: now, messages: [] };
  }

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }); }, [thread.messages.length, busy]);
  useEffect(() => () => { rec.current?.cancel(); stopSpeaking(); }, []);
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);
  useEffect(() => { if (recording && seconds >= 45) void toggleMic(); }, [seconds]);

  function update(fn: (t: AskThread) => AskThread) {
    setThread((t) => {
      const next = fn(t);
      if (next.messages.some((m) => m.result)) save(next);
      return next;
    });
  }

  async function run(input: { text: string } | { audio: Blob }, shownText: string, source = me.code) {
    if (left === 0) { openPaywall("translations"); return; }
    setNotice("");
    const userId = newId(), botId = newId(), now = Date.now();
    update((t) => ({ ...t, target: target.code, updatedAt: now, messages: [...t.messages,
      { id: userId, role: "user", at: now, text: shownText }, { id: botId, role: "bot", at: now }] }));
    try {
      const r: AskResult = await api.ask(source, target.code, input);
      update((t) => ({
        ...t, updatedAt: Date.now(), title: t.title || r.question,
        messages: t.messages.map((m) => m.id === userId ? { ...m, text: r.question }
          : m.id === botId ? { ...m, result: r, at: Date.now() } : m),
      }));
      void speak(api, r.translation, r.target, prefs.rate, r.voice_gender ?? voice);
      if (left !== null) void refresh();
    } catch (e) {
      if (handleError(e)) {
        update((t) => ({ ...t, messages: t.messages.filter((m) => m.id !== userId && m.id !== botId) }));
        return;
      }
      update((t) => ({ ...t, messages: t.messages.map((m) => m.id === botId ? { ...m, error: errorText(e) } : m) }));
    }
  }

  async function toggleMic() {
    if (recording) {
      const r = rec.current; rec.current = null; setRecording(false);
      if (r) void run({ audio: await r.stop() }, "🎤 …");
      return;
    }
    if (left === 0) { openPaywall("translations"); return; }
    stopSpeaking();
    const r = new Recorder();
    try { await r.start(); } catch (e) { setNotice(micErrorMessage(e)); return; }
    rec.current = r; setSeconds(0); setRecording(true);
  }

  function send(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    void run({ text: t }, t);
  }

  function newChat() { stopSpeaking(); setThread(blank()); }

  return (
    <div className="screen chat">
      <header className="chat-head">
        <div className="bot-id">
          <BotAvatar size={42} thinking={busy} />
          <div>
            <div className="bot-name">Bolverse <AiTag /></div>
            <div className="bot-status"><span className="dot" /> {busy ? "Thinking…" : "Your AI interpreter"}</div>
          </div>
        </div>
        <div className="head-actions">
          <label className="target-pick">
            <span>To</span>
            <LangSelect value={target.code} exclude={me.code} label="Translate to" onChange={(code) => updatePrefs({ askTarget: code })} />
          </label>
          <button className="iconbtn round" onClick={newChat} aria-label="New chat" title="New chat">{Icon.plus}</button>
        </div>
      </header>

      <div className="messages" ref={listRef} aria-live="polite">
        {thread.messages.length === 0 && !recording ? (
          <div className="ask-hero">
            <BotAvatar size={60} />
            <p className="hero-hi">Hi{firstName(account) ? ` ${firstName(account)}` : ""} 👋</p>
            <h1 className="hero-q">What would you like to say in <span className="grad-text">{target.name}</span>?</h1>
            <p className="muted">Speak or type in {me.name} (Hinglish works too). I'll translate it, say it out loud, and show you how to read it.</p>
            <p className="chips-label">{Icon.sparkle} Try one</p>
            <div className="chips">
              {SUGGESTIONS.slice(0, 4).map((s) => <Chip key={s} onClick={() => void run({ text: s }, s, "en-US")}>{s}</Chip>)}
            </div>
          </div>
        ) : null}
        {thread.messages.map((m) => m.role === "user" ? (
          <div key={m.id} className="msg user"><div className="bubble user-bubble" dir="auto">{m.text}</div></div>
        ) : (
          <div key={m.id} className="msg bot">
            <BotAvatar size={32} thinking={!m.result && !m.error} />
            {m.result ? <Answer result={m.result} me={me.name} rate={prefs.rate} voice={voice} />
              : m.error ? <div className="bubble bot-bubble error-bubble">{m.error}</div>
              : <div className="bubble bot-bubble typing" aria-label="Bolverse is translating"><i /><i /><i /></div>}
          </div>
        ))}
        {recording && (
          <div className="msg user"><div className="bubble user-bubble listening">Listening… {seconds}s</div></div>
        )}
      </div>

      <div className="composer">
        {notice && <p className="notice">{notice}</p>}
        <form className="composer-row" onSubmit={send}>
          <button type="button" className={"mic-btn" + (recording ? " live" : "")} onClick={() => void toggleMic()}
            aria-label={recording ? "Stop and translate" : `Speak in ${me.name}`} disabled={busy && !recording}>
            {recording ? Icon.stop : Icon.mic}
          </button>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Type in ${me.name}`} aria-label="Type your sentence" dir="auto" />
          <button className="send-btn" type="submit" disabled={!text.trim() || busy} aria-label="Translate">{Icon.send}</button>
        </form>
        <p className="composer-hint">
          {recording ? <>Listening… {seconds}s · tap ■ when you're done</> : `Tap the mic and speak ${me.name}`}
          {left !== null && <> · <span className="quota">{freeLeftText(account)}</span></>}
        </p>
      </div>
    </div>
  );
}

function Answer({ result, me, rate, voice }: { result: AskResult; me: string; rate: number; voice: VoiceGender | null }) {
  const api = useApi();
  const [copied, setCopied] = useState(false);
  const target = findLang(result.target);
  const gender = result.voice_gender ?? voice;
  return (
    <div className="bubble bot-bubble answer">
      <div className="answer-lang">{Icon.sparkle}{target.name}</div>
      <div className="answer-text" lang={target.code} dir="auto">{result.translation}</div>
      {(result.native_reading || result.english_reading) && (
        <div className="readings">
          {result.native_reading && (
            <div className="reading"><span className="reading-label">Read it in {me}</span><span dir="auto">{result.native_reading}</span></div>
          )}
          {result.english_reading && (
            <div className="reading"><span className="reading-label">In English letters</span><span>{result.english_reading}</span></div>
          )}
        </div>
      )}
      <div className="answer-actions">
        <button className="btn primary small-btn" onClick={() => void speak(api, result.translation, target.code, rate, gender)}>{Icon.speaker} Play</button>
        <button className="btn ghost small-btn" onClick={() => void speak(api, result.translation, target.code, Math.max(0.6, rate * 0.7), gender)}>{Icon.slow} Slowly</button>
        <button className="btn ghost small-btn" onClick={() => { void navigator.clipboard?.writeText(result.translation); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
          {copied ? Icon.check : Icon.copy} {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
