import { useEffect, useMemo, useState, type ReactElement } from "react";
import { createApi, createSessionStore, freeLeftText, type Profile, type Thread } from "@bolverse/shared";
import { ApiContext } from "./lib/api";
import { AccountProvider, useAccount } from "./lib/account";
import { ChatsProvider, useChats } from "./lib/chats";
import { stopSpeaking } from "./lib/audio";
import { browserRegion, deviceId, loadGuestChoice, loadPrefs, loadTokens, savePrefs, saveGuestChoice, saveTokens, SERVER_URL } from "./lib/store";
import { BotAvatar, Icon, Wordmark } from "./components/Brand";
import { AuthScreen } from "./screens/Auth";
import { Ask } from "./screens/Ask";
import { Connect } from "./screens/Connect";
import { Converse } from "./screens/Converse";
import { History } from "./screens/History";
import { ProfileScreen } from "./screens/Profile";

type Tab = "ask" | "converse" | "connect" | "history" | "profile";

export function App() {
  const [prefs, setPrefs] = useState<Profile>(loadPrefs);
  // One token store for the whole app; it re-reads localStorage so several tabs share one session.
  const [session] = useState(() => createSessionStore(loadTokens(), saveTokens, loadTokens));
  const api = useMemo(() => createApi({ baseUrl: SERVER_URL, deviceId: deviceId(), session, region: browserRegion() }), [session]);
  const updatePrefs = (patch: Partial<Profile>) => setPrefs((p) => { const n = { ...p, ...patch }; savePrefs(n); return n; });

  return (
    <ApiContext.Provider value={api}>
      <AccountProvider api={api} session={session}>
        <Gate prefs={prefs} updatePrefs={updatePrefs} />
      </AccountProvider>
    </ApiContext.Provider>
  );
}

function Gate({ prefs, updatePrefs }: { prefs: Profile; updatePrefs: (p: Partial<Profile>) => void }) {
  const { account, ready, loginOpen, closeLogin } = useAccount();
  const [guest, setGuest] = useState(loadGuestChoice);
  if (!ready) return <div className="splash"><BotAvatar size={72} thinking /><p className="muted">Waking up your AI interpreter…</p></div>;
  const signedIn = account.plan === "open" || account.user !== null;
  // First visit: the welcome screen, with "try it without an account". Later the login opens on demand.
  if (!signedIn && !guest) return <AuthScreen onGuest={() => { saveGuestChoice(true); setGuest(true); }} />;
  if (loginOpen && !signedIn) return <AuthScreen onClose={closeLogin} />;
  return (
    <ChatsProvider owner={account.user?.id ?? "open"} enabled={!!account.user} rate={prefs.rate} readAloud={prefs.speakTheirs}>
      <Shell prefs={prefs} updatePrefs={updatePrefs} />
    </ChatsProvider>
  );
}

function Shell({ prefs, updatePrefs }: { prefs: Profile; updatePrefs: (p: Partial<Profile>) => void }) {
  const { account } = useAccount();
  const { unread } = useChats();
  const [tab, setTab] = useState<Tab>("ask");
  const [openThread, setOpenThread] = useState<Extract<Thread, { kind: "ask" }> | null>(null);
  const [askKey, setAskKey] = useState(0);
  const owner = account.user?.id ?? "open";
  const freeText = freeLeftText(account);
  useEffect(() => { stopSpeaking(); }, [tab]);

  const tabs: [Tab, string, ReactElement][] = [
    ["ask", "Ask", Icon.sparkle], ["converse", "Talk", Icon.chat], ["connect", "Connect", Icon.qr],
    ["history", "History", Icon.history], ["profile", "Profile", Icon.user],
  ];

  return (
    <div className="shell">
      <nav className="sidenav" aria-label="Sections">
        <Wordmark />
        {tabs.map(([id, label, icon]) => (
          <button key={id} className="navitem" aria-current={tab === id ? "page" : undefined} onClick={() => { if (id === "ask" && tab !== "ask") setOpenThread(null); setTab(id); }}>{icon}<span>{label}</span>{id === "connect" && unread > 0 && <span className="navbadge">{unread}</span>}</button>
        ))}
        <div className="side-foot">
          {freeText ? <>{freeText}</> : account.plan === "premium" ? <>✨ Premium: unlimited</> : null}
        </div>
      </nav>
      <main className="content">
        {tab === "ask" && <Ask key={askKey} prefs={prefs} updatePrefs={updatePrefs} owner={owner} open={openThread} />}
        {tab === "converse" && <Converse prefs={prefs} updatePrefs={updatePrefs} owner={owner} />}
        {tab === "connect" && <Connect rate={prefs.rate} />}
        {tab === "history" && <History owner={owner} rate={prefs.rate} onContinue={(t) => {
          if (t.kind === "ask") { setOpenThread(t); setAskKey((k) => k + 1); setTab("ask"); }
        }} />}
        {tab === "profile" && <ProfileScreen prefs={prefs} updatePrefs={updatePrefs} owner={owner} />}
      </main>
      <nav className="tabbar" aria-label="Sections">
        {tabs.map(([id, label, icon]) => (
          <button key={id} className="tab" aria-current={tab === id ? "page" : undefined}
            onClick={() => { if (id === "ask" && tab !== "ask") setOpenThread(null); setTab(id); }}><span className="ti">{icon}</span><span>{label}</span>{id === "connect" && unread > 0 && <span className="navbadge">{unread}</span>}</button>
        ))}
      </nav>
    </div>
  );
}
