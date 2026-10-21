import { useEffect, useState, type FormEvent } from "react";
import { ApiError, DIAL_CODES, dialCodeFor, LANGUAGES, type Gender, type VoiceGender } from "@bolverse/shared";
import { Icon, LangSelect, Wordmark } from "../components/Brand";
import { errorText, useApi } from "../lib/api";
import { useAccount } from "../lib/account";
import { browserLang, browserRegion, SERVER_URL } from "../lib/store";

type Step = "phone" | "code" | "details";

/** Welcome screen: mobile number, SMS code, and for first-time users their name, birthday, gender and language. */
/** Letters (any script), spaces and . ' - only; the server checks the same. */
export function nameProblem(name: string): string {
  const n = name.trim();
  if (!n) return "Enter your name.";
  if (n.length > 80) return "That name is too long.";
  if (!/^[\p{L}\p{M} .'-]+$/u.test(n)) return "Use letters only in your name.";
  return "";
}

export function AuthScreen({ onGuest, onClose }: { onGuest?: () => void; onClose?: () => void }) {
  const api = useApi();
  const { signIn, offline } = useAccount();
  const [step, setStep] = useState<Step>("phone");
  const [dial, setDial] = useState(() => dialCodeFor(browserRegion()));
  const [number, setNumber] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string>();
  const [registered, setRegistered] = useState(false);
  const [signupToken, setSignupToken] = useState("");
  const [name, setName] = useState("");
  const [dob, setDob] = useState("");
  const [gender, setGender] = useState<Gender | "">("");
  const [voice, setVoice] = useState<VoiceGender | "">("");
  const [language, setLanguage] = useState(browserLang);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resendIn, setResendIn] = useState(0);
  const [hello, setHello] = useState(0);

  const phone = `${dial}${number.replace(/\D/g, "")}`;
  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  useEffect(() => {
    if (step !== "phone" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setHello((i) => (i + 1) % LANGUAGES.length), 2200);
    return () => clearInterval(t);
  }, [step]);

  async function sendCode(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true); setError("");
    try {
      const r = await api.requestOtp(phone);
      setRegistered(r.registered); setDevCode(r.dev_code); setResendIn(r.resend_in); setCode(""); setStep("code");
    } catch (err) { setError(errorText(err)); }
    setBusy(false);
  }

  async function verify(value = code) {
    if (value.length !== 6 || busy) return;
    setBusy(true); setError("");
    try {
      const r = await api.verify(phone, value);
      if (r.status === "signed_in") { signIn(r); return; }
      setSignupToken(r.signup_token); setStep("details");
    } catch (err) { setError(errorText(err)); }
    setBusy(false);
  }

  async function finish(e: FormEvent) {
    e.preventDefault();
    const bad = nameProblem(name);
    if (bad) { setError(bad); return; }
    if (!gender) { setError("Choose your gender. Bolverse uses it for your voice and to word sentences correctly."); return; }
    if (gender === "other" && !voice) { setError("Choose the voice Bolverse should use for you."); return; }
    setBusy(true); setError("");
    try {
      const r = await api.complete({ signup_token: signupToken, name: name.trim(), dob, gender,
        voice_gender: gender === "other" ? (voice as VoiceGender) : undefined, language });
      signIn(r);
    } catch (err) {
      if (err instanceof ApiError && err.code === "signup_expired") { setStep("phone"); }
      setError(errorText(err)); setBusy(false);
    }
  }

  const g = LANGUAGES[hello];
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-top"><Wordmark />{onClose && <button className="linkbtn" type="button" onClick={onClose}>Not now</button>}</div>
        {step === "phone" && (
          <form onSubmit={sendCode}>
            <div className="auth-hero">
              <div className="hello" lang={g.code} dir="auto" aria-hidden="true">{g.hello}</div>
              <h1>Talk with AI in <span className="grad-text">any language</span></h1>
              <p className="lead">Say it in your language. Bolverse translates it and speaks it out loud, in a voice that sounds like you.</p>
              <ul className="perks" aria-label="What you get">
                <li>{Icon.mic}Just speak</li><li>{Icon.globe}64 languages</li><li>{Icon.speaker}Your voice</li>
              </ul>
            </div>
            <div className="field">
              <label htmlFor="au-phone">Your mobile number</label>
              <div className="phonerow">
                <select aria-label="Country code" value={dial} onChange={(e) => setDial(e.target.value)}>
                  {DIAL_CODES.map((d) => <option key={d.region} value={d.code}>{d.code} {d.name}</option>)}
                </select>
                <input id="au-phone" type="tel" inputMode="tel" autoComplete="tel-national" value={number} autoFocus
                  onChange={(e) => setNumber(e.target.value)} placeholder="98765 43210" />
              </div>
              <span className="hint">We'll text you a 6-digit code. No password needed.</span>
            </div>
            {(error || offline) && <p className="error" role="alert">{error || offline}</p>}
            <button className="btn big primary wide" type="submit" disabled={busy || number.replace(/\D/g, "").length < 6}>
              {busy ? "Sending…" : onClose ? "Continue" : "Get started"}
            </button>
            {onGuest && (
              <button type="button" className="btn ghost wide guest-btn" onClick={onGuest}>Try it first, without an account</button>
            )}
          </form>
        )}

        {step === "code" && (
          <form onSubmit={(e) => { e.preventDefault(); void verify(); }}>
            <h1>Enter your code</h1>
            <p className="lead">Sent to {dial} {number}. <button type="button" className="linkbtn" onClick={() => setStep("phone")}>Change</button></p>
            {devCode && <p className="notice">Test mode: your code is <strong>{devCode}</strong></p>}
            <input className="otp" value={code} autoComplete="one-time-code" inputMode="numeric" maxLength={6} autoFocus
              aria-label="6-digit code" onChange={(e) => {
                const v = e.target.value.replace(/\D/g, "").slice(0, 6);
                setCode(v);
                if (v.length === 6) void verify(v);
              }} />
            {error && <p className="error" role="alert">{error}</p>}
            <button className="btn big primary wide" type="submit" disabled={busy || code.length !== 6}>
              {busy ? "Checking…" : registered ? "Log in" : "Verify"}
            </button>
            <p className="small muted center">
              {resendIn > 0 ? `You can ask for a new code in ${resendIn}s.` :
                <button type="button" className="linkbtn" onClick={() => void sendCode()}>Send a new code</button>}
            </p>
          </form>
        )}

        {step === "details" && (
          <form onSubmit={finish}>
            <h1>Nice to meet you</h1>
            <p className="lead">A few details so Bolverse can speak for you properly.</p>
            <div className="field">
              <label htmlFor="au-name">Your name</label>
              <input id="au-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required autoFocus />
            </div>
            <div className="field">
              <label htmlFor="au-dob">Date of birth</label>
              <input id="au-dob" type="date" value={dob} max={today} min="1900-01-01" onChange={(e) => setDob(e.target.value)} required />
            </div>
            <div className="field">
              <span className="label" id="au-gender">Gender</span>
              <div className="pills" role="radiogroup" aria-labelledby="au-gender">
                {(["female", "male", "other"] as Gender[]).map((g) => (
                  <button key={g} type="button" role="radio" aria-checked={gender === g}
                    className={"pill" + (gender === g ? " on" : "")} onClick={() => setGender(g)}>
                    {g === "female" ? "Female" : g === "male" ? "Male" : "Other"}
                  </button>
                ))}
              </div>
              <span className="hint">Bolverse speaks for you in this voice, and words sentences for you correctly: in Hindi "मैं थका हूँ" or "मैं थकी हूँ".</span>
            </div>
            {gender === "other" && (
              <div className="field">
                <span className="label" id="au-voice">Which voice should speak for you?</span>
                <div className="pills" role="radiogroup" aria-labelledby="au-voice">
                  {(["female", "male"] as VoiceGender[]).map((v) => (
                    <button key={v} type="button" role="radio" aria-checked={voice === v}
                      className={"pill" + (voice === v ? " on" : "")} onClick={() => setVoice(v)}>
                      {v === "female" ? "Female voice" : "Male voice"}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="field">
              <label htmlFor="au-lang">Your language</label>
              <LangSelect id="au-lang" value={language} onChange={setLanguage} label="Your language" />
              <span className="hint">You'll speak and read in this language.</span>
            </div>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="btn big primary wide" type="submit" disabled={busy || !name.trim() || !dob}>
              {busy ? "Setting up…" : "Start talking"}
            </button>
          </form>
        )}

        {offline && import.meta.env.DEV && (
          <p className="small muted center">Developer note: the app is looking for the server at {SERVER_URL}. Set VITE_API_URL in apps/web/.env and restart npm run web.</p>
        )}
      </div>
    </div>
  );
}
