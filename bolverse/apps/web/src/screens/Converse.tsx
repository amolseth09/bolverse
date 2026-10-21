import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  findLang, freeLeftText, leftToday, newId, otherThan,
  type ConverseMessage, type Profile, type Thread, type TranslateResult, type VoiceGender,
} from "@bolverse/shared";
import { Icon, LangSelect } from "../components/Brand";
import { errorText, useApi } from "../lib/api";
import { useAccount } from "../lib/account";
import { micErrorMessage, Recorder, speak, stopSpeaking } from "../lib/audio";
import { useHistory } from "../lib/history";

type Side = "me" | "them";
type ConvThread = Extract<Thread, { kind: "converse" }>;
interface Pending { id: string; who: Side; text: string; error?: string }

const MAX_SECONDS = 60;

export function Converse({ prefs, updatePrefs, owner }: { prefs: Profile; updatePrefs: (p: Partial<Profile>) => void; owner: string }) {
  const api = useApi();
  const { account, refresh, openPaywall, handleError } = useAccount();
  const { save } = useHistory(owner);
  const me = findLang(account.user?.language ?? prefs.myLang);
  const them = findLang(otherThan(me.code, prefs.target));
  const myVoice: VoiceGender | null = account.user?.voice_gender ?? null;
  const [theirGender, setTheirGender] = useState<VoiceGender | "auto">("auto");
  const [thread, setThread] = useState<ConvThread>(() => blank());
  const [pending, setPending] = useState<Pending[]>([]);
  const [recording, setRecording] = useState<Side | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [notice, setNotice] = useState("");
  const [typed, setTyped] = useState("");
  const [typeAs, setTypeAs] = useState<Side>("me");
  const rec = useRef<Recorder | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const left = leftToday(account);

  function blank(): ConvThread {
    const now = Date.now();
    return { id: newId(), kind: "converse", title: "", source: me.code, target: them.code, createdAt: now, updatedAt: now, messages: [] };
  }

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [thread.messages.length, pending.length, recording]);
  useEffect(() => () => { rec.current?.cancel(); stopSpeaking(); }, []);
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);
  useEffect(() => { if (recording && seconds >= MAX_SECONDS) void toggleMic(recording); }, [seconds]);

  const pair = (who: Side) => (who === "me" ? [me, them] : [them, me]);
  const genderFor = (who: Side) => (who === "me" ? myVoice : theirGender === "auto" ? null : theirGender);

  async function run(who: Side, placeholder: string, work: () => Promise<TranslateResult & { original?: string; speaker_gender?: VoiceGender | null }>) {
    const to = pair(who)[1];
    const id = newId();
    setPending((p) => [...p, { id, who, text: placeholder }]);
    try {
      const r = await work();
      const gender = r.speaker_gender ?? genderFor(who);
      const msg: ConverseMessage = { id, who, at: Date.now(), original: r.original ?? placeholder, translation: r.translation,
        romanized: r.romanized, to: to.code, gender };
      setPending((p) => p.filter((x) => x.id !== id));
      setThread((t) => {
        const next = { ...t, target: them.code, updatedAt: Date.now(), title: t.title || msg.original, messages: [...t.messages, msg] };
        save(next);
        return next;
      });
      if (who === "me" || prefs.speakTheirs) void speak(api, r.translation, to.code, prefs.rate, gender);
      if (left !== null) void refresh();
    } catch (e) {
      if (handleError(e)) { setPending((p) => p.filter((x) => x.id !== id)); return; }
      setPending((p) => p.map((x) => (x.id === id ? { ...x, error: errorText(e) } : x)));
    }
  }

  async function toggleMic(who: Side) {
    if (recording) {
      const r = rec.current, side = recording;
      rec.current = null; setRecording(null);
      if (!r) return;
      const blob = await r.stop();
      const [from, to] = pair(side);
      void run(side, "…", () => api.converse(blob, from.code, to.code, side, genderFor(side)));
      return;
    }
    if (left === 0) { openPaywall("translations"); return; }
    stopSpeaking(); setNotice("");
    const r = new Recorder();
    try { await r.start(); } catch (e) { setNotice(micErrorMessage(e)); return; }
    rec.current = r; setSeconds(0); setRecording(who);
  }

  function sendTyped(e: FormEvent) {
    e.preventDefault();
    const text = typed.trim();
    if (!text) return;
    if (left === 0) { openPaywall("translations"); return; }
    setTyped("");
    const [from, to] = pair(typeAs);
    void run(typeAs, text, async () => ({ original: text, ...(await api.translate(text, from.code, to.code, typeAs, genderFor(typeAs))) }));
  }

  return (
    <div className="screen converse">
      <div className="pairbar">
        <div className="side you">
          <span className="who">You speak</span><span className="lang">{me.native}</span>
          <span className="small">{myVoice === "male" ? "Male voice" : "Female voice"}</span>
        </div>
        <button className="swapicon" aria-label="New conversation" title="New conversation"
          onClick={() => { stopSpeaking(); setThread(blank()); setPending([]); }}>{Icon.plus}</button>
        <div className="side them">
          <span className="who">They speak</span>
          <label className="lang-inline">
            <span className="lang">{them.native}</span><span className="change">Change ▾</span>
            <LangSelect value={them.code} exclude={me.code} label="The other person's language" onChange={(code) => updatePrefs({ target: code })} />
          </label>
          <div className="seg mini" role="group" aria-label="Their voice">
            {(["auto", "female", "male"] as const).map((g) => (
              <button key={g} type="button" aria-pressed={theirGender === g} onClick={() => setTheirGender(g)}>
                {g === "auto" ? "Auto" : g === "female" ? "♀" : "♂"}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="transcript" ref={listRef} aria-live="polite">
        {thread.messages.length === 0 && pending.length === 0 && !recording && (
          <div className="empty">
            <p className="display">Talk face to face, <span className="grad-text">AI in the middle.</span></p>
            <ol className="steps">
              <li><b>1</b><span>Tap <strong>I speak</strong> and talk in {me.name}.</span></li>
              <li><b>2</b><span>Bolverse says it aloud in {them.name}, in your voice.</span></li>
              <li><b>3</b><span>Hand over the phone: they tap <strong>They speak</strong> to reply.</span></li>
            </ol>
          </div>
        )}
        {thread.messages.map((m) => (
          <div key={m.id} className={"bubble " + m.who}>
            <div className="said" dir="auto">{m.original}</div>
            <div className="row">
              <div>
                <div className="tr" lang={m.to} dir="auto">{m.translation}</div>
                {m.romanized && <div className="rom">{m.romanized}</div>}
              </div>
              <button className="iconbtn" aria-label="Play again" onClick={() => void speak(api, m.translation, m.to, prefs.rate, m.gender)}>{Icon.speaker}</button>
            </div>
          </div>
        ))}
        {pending.map((p) => (
          <div key={p.id} className={"bubble " + p.who}>
            <div className="said" dir="auto">{p.text}</div>
            {p.error ? <div className="small" style={{ fontWeight: 600 }}>{p.error}</div> : <div className="typing inline"><i /><i /><i /></div>}
          </div>
        ))}
        {recording && <div className={"bubble interim " + recording}><div className="tr">Listening… 0:{String(seconds).padStart(2, "0")}</div></div>}
      </div>

      <div className="controls">
        {notice && <div className="notice" role="status">{notice}</div>}
        <div className="mics">
          {(["me", "them"] as Side[]).map((side) => {
            const [from, to] = pair(side);
            const live = recording === side;
            return (
              <button key={side} className={`mic ${side}${live ? " live" : ""}`} aria-pressed={live}
                disabled={!!recording && !live} onClick={() => void toggleMic(side)}>
                <span className="mi">{live ? Icon.stop : Icon.mic}</span>
                <span className="big">{live ? "Tap to send" : side === "me" ? "I speak" : "They speak"}</span>
                <span className="dir">{from.name} to {to.name}</span>
              </button>
            );
          })}
        </div>
        <form className="typerow" onSubmit={sendTyped}>
          <div className="seg" role="group" aria-label="Who is typing">
            <button type="button" aria-pressed={typeAs === "me"} onClick={() => setTypeAs("me")}>Me</button>
            <button type="button" aria-pressed={typeAs === "them"} onClick={() => setTypeAs("them")}>Them</button>
          </div>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type a message" dir="auto"
            placeholder={`Type in ${(typeAs === "me" ? me : them).name}`} />
          <button className="btn primary" type="submit" disabled={!typed.trim()}>Say it</button>
        </form>
        {left !== null && <p className="composer-hint"><span className="quota">{freeLeftText(account)}</span></p>}
      </div>
    </div>
  );
}
