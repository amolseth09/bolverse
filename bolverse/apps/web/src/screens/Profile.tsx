import { useState } from "react";
import { accountsEnabled, findLang, formatDay, freeLeftText, isGuest, leftToday, planLabel, type Profile, type VoiceGender } from "@bolverse/shared";
import { Icon, LangSelect, Logo } from "../components/Brand";
import { errorText, useApi } from "../lib/api";
import { useAccount } from "../lib/account";
import { speak } from "../lib/audio";
import { useHistory } from "../lib/history";

export function ProfileScreen({ prefs, updatePrefs, owner }: { prefs: Profile; updatePrefs: (p: Partial<Profile>) => void; owner: string }) {
  const api = useApi();
  const { account, refresh, openPaywall, signOut, openLogin } = useAccount();
  const { threads, clear } = useHistory(owner);
  const [saving, setSaving] = useState("");
  const user = account.user;
  const me = findLang(user?.language ?? prefs.myLang);
  const premium = account.plan === "premium";
  const left = leftToday(account);

  async function change(patch: { language?: string; voice_gender?: VoiceGender }) {
    if (!user) { if (patch.language) updatePrefs({ myLang: patch.language }); return; }
    setSaving("Saving…");
    try { await api.updateMe(patch); await refresh(); setSaving("Saved"); }
    catch (e) { setSaving(errorText(e)); }
    setTimeout(() => setSaving(""), 1500);
  }

  return (
    <div className="screen page">
      {isGuest(account) && (
        <section className="acct" aria-label="Account">
          <div className="acct-top">
            <span className="avatar-letter" aria-hidden="true">?</span>
            <div><h1>You're a guest</h1><span className="badge">{freeLeftText(account) ?? "Free"}</span></div>
          </div>
          <p className="muted">Log in with your mobile number to keep your voice settings, use Connect, and get Premium.</p>
          <button className="btn primary" onClick={() => openLogin()}>Log in or sign up</button>
        </section>
      )}
      {user && (
        <section className={"acct" + (premium ? " premium" : "")} aria-label="Account">
          <div className="acct-top">
            <span className="avatar-letter" aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span>
            <div>
              <h1>{user.name}</h1>
              <span className="badge">{planLabel(account)}</span>
            </div>
          </div>
          {premium && account.subscription ? (
            <p>Valid until <strong>{formatDay(account.subscription.valid_until)}</strong> ({account.subscription.days_left} {account.subscription.days_left === 1 ? "day" : "days"} left). Unlimited translations.</p>
          ) : (
            <div className="usage">
              <div className="usage-row"><span>{account.usage.kind === "daily" ? "Today's free translations" : "Free translations used"}</span><strong>{account.usage.today} of {account.usage.daily_limit}</strong></div>
              <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={account.usage.daily_limit ?? 0} aria-valuenow={account.usage.today}>
                <i style={{ width: `${Math.min(100, (account.usage.today / (account.usage.daily_limit || 1)) * 100)}%` }} />
              </div>
              <span className="small muted">{left} left.{account.usage.kind === "daily" ? " Resets at midnight." : " Then Premium keeps you going."}</span>
            </div>
          )}
          <dl className="facts">
            <dt>Mobile</dt><dd>{user.phone}</dd>
            <dt>Date of birth</dt><dd>{formatDay(user.dob)}</dd>
            <dt>Gender</dt><dd>{user.gender ? user.gender[0].toUpperCase() + user.gender.slice(1) : "Not set"}</dd>
            <dt>Member since</dt><dd>{formatDay(user.member_since)}</dd>
          </dl>
          <button className={"btn " + (premium ? "" : "primary")} onClick={() => openPaywall("upgrade")}>{premium ? "Extend Premium" : "Get Premium"}</button>
        </section>
      )}

      <h2>Your voice and language</h2>
      <div className="field">
        <label htmlFor="pf-lang">I speak</label>
        <LangSelect id="pf-lang" value={me.code} label="Your language" onChange={(code) => void change({ language: code })} />
      </div>
      {user && (
        <div className="field">
          <span className="label" id="pf-voice">Bolverse speaks for me in a</span>
          <div className="pills" role="radiogroup" aria-labelledby="pf-voice">
            {(["female", "male"] as VoiceGender[]).map((v) => (
              <button key={v} type="button" role="radio" aria-checked={user.voice_gender === v}
                className={"pill" + (user.voice_gender === v ? " on" : "")} onClick={() => void change({ voice_gender: v })}>
                {v === "female" ? "Female voice" : "Male voice"}
              </button>
            ))}
          </div>
          <span className="hint">Also used to word sentences about you correctly.</span>
        </div>
      )}
      {saving && <p className="small muted" role="status">{saving}</p>}
      <div className="field">
        <label htmlFor="pf-rate">Speaking speed: {prefs.rate.toFixed(1)}x</label>
        <input id="pf-rate" type="range" min="0.6" max="1.3" step="0.1" value={prefs.rate} onChange={(e) => updatePrefs({ rate: parseFloat(e.target.value) })} />
        <button className="btn ghost fit" onClick={() => void speak(api, me.hello, me.code, prefs.rate, user?.voice_gender)}>{Icon.speaker} Test voice</button>
      </div>
      <label className="check">
        <input type="checkbox" checked={prefs.speakTheirs} onChange={(e) => updatePrefs({ speakTheirs: e.target.checked })} />
        <span>In Converse, read the other person's words aloud to me<br /><span className="small muted">Turn off if you'd rather just read them.</span></span>
      </label>

      <h2>Your data</h2>
      <p className="muted">Your {threads.length} saved {threads.length === 1 ? "conversation stays" : "conversations stay"} only on this device. Bolverse's server keeps your account and your free-translation count, never what you said.</p>
      <button className="btn ghost danger-text fit" disabled={!threads.length} onClick={() => { if (confirm("Delete all conversations on this device?")) clear(); }}>{Icon.trash} Clear history</button>


      {accountsEnabled(account) && user && <button className="btn ghost wide logout" onClick={() => void signOut()}>Log out</button>}
      <div className="about"><Logo size={28} /><span className="small muted">Bolverse · Talk with AI in any language</span></div>
    </div>
  );
}
