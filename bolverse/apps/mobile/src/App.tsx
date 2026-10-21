import { useEffect, useMemo, useState } from "react";
import { Alert, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { useFonts, BricolageGrotesque_700Bold, BricolageGrotesque_800ExtraBold } from "@expo-google-fonts/bricolage-grotesque";
import { createApi, createSessionStore, inviteToken, type Profile, type SessionStore, type Thread } from "@bolverse/shared";
import { ApiContext } from "./lib/api";
import { AccountProvider, useAccount } from "./lib/account";
import { ChatsProvider, useChats } from "./lib/chats";
import { onNotificationTap } from "./lib/notify";
import { initAudio, stopSpeaking } from "./lib/audio";
import { deviceRegion, loadDeviceId, loadGuestChoice, loadPrefs, loadTokens, savePrefs, saveGuestChoice, saveTokens, SERVER_URL } from "./lib/store";
import { useColors } from "./lib/theme";
import { Aurora, BotAvatar, GradFill, Icons, shadow } from "./components/Brand";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AuthScreen } from "./screens/Auth";
import { Ask } from "./screens/Ask";
import { Connect, useJoin } from "./screens/Connect";
import { Converse } from "./screens/Converse";
import { History } from "./screens/History";
import { ProfileScreen } from "./screens/Profile";

type Tab = "ask" | "converse" | "connect" | "history" | "profile";

// Keep the startup screen (logo) up until fonts and settings are loaded, instead of a blank screen.
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function App() {
  return <SafeAreaProvider><ErrorBoundary><Root /></ErrorBoundary></SafeAreaProvider>;
}

function Root() {
  const c = useColors();
  const [fontsLoaded] = useFonts({ BricolageGrotesque_700Bold, BricolageGrotesque_800ExtraBold });
  const [prefs, setPrefs] = useState<Profile | null>(null);
  const [deviceId, setDeviceId] = useState("");
  const [session, setSession] = useState<SessionStore | null>(null);
  const [guest, setGuest] = useState(false);

  useEffect(() => {
    void initAudio();
    Promise.all([loadPrefs(), loadDeviceId(), loadTokens(), loadGuestChoice()]).then(([p, id, t, g]) => {
      setPrefs(p); setDeviceId(id); setSession(createSessionStore(t, saveTokens)); setGuest(g);
    });
  }, []);

  const api = useMemo(
    () => createApi({ baseUrl: SERVER_URL, deviceId, session: session ?? undefined, region: deviceRegion() }),
    [deviceId, session],
  );
  const updatePrefs = (patch: Partial<Profile>) => setPrefs((p) => { const n = { ...(p as Profile), ...patch }; savePrefs(n); return n; });

  const ready = !!(fontsLoaded && prefs && deviceId && session);
  useEffect(() => { if (ready) SplashScreen.hideAsync().catch(() => {}); }, [ready]);
  if (!ready || !prefs || !session) return <View style={{ flex: 1, backgroundColor: c.bg }} />;

  return (
    <ApiContext.Provider value={api}>
      <AccountProvider api={api} session={session}>
        <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }} edges={["top", "left", "right"]}>
          <Aurora />
          <StatusBar style="auto" />
          <Gate prefs={prefs} updatePrefs={updatePrefs} deviceId={deviceId} guest={guest}
            onGuest={() => { saveGuestChoice(true); setGuest(true); }} />
        </SafeAreaView>
      </AccountProvider>
    </ApiContext.Provider>
  );
}

function Gate({ prefs, updatePrefs, deviceId, guest, onGuest }: {
  prefs: Profile; updatePrefs: (p: Partial<Profile>) => void; deviceId: string; guest: boolean; onGuest: () => void;
}) {
  const c = useColors();
  const { account, ready, loginOpen, closeLogin } = useAccount();
  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 16 }}>
        <BotAvatar size={72} thinking /><Text style={{ color: c.muted }}>Waking up your AI interpreter…</Text>
      </View>
    );
  }
  const signedIn = account.plan === "open" || account.user !== null;
  // First run: the welcome screen, with "try it without an account". Later the login opens on demand.
  if (!signedIn && !guest) return <AuthScreen onGuest={onGuest} />;
  if (loginOpen && !signedIn) return <AuthScreen onClose={closeLogin} />;
  return (
    <ChatsProvider owner={account.user?.id ?? "open"} enabled={!!account.user} rate={prefs.rate} readAloud={prefs.speakTheirs}>
      <Shell prefs={prefs} updatePrefs={updatePrefs} deviceId={deviceId} />
    </ChatsProvider>
  );
}

function Shell({ prefs, updatePrefs, deviceId }: { prefs: Profile; updatePrefs: (p: Partial<Profile>) => void; deviceId: string }) {
  const c = useColors();
  const { account } = useAccount();
  const { unread, setOpenId } = useChats();
  const [tab, setTab] = useState<Tab>("ask");
  const [openThread, setOpenThread] = useState<Extract<Thread, { kind: "ask" }> | null>(null);
  const openChat = (id: string) => { setOpenId(id); setTab("connect"); };
  const join = useJoin(openChat);

  // A tapped notification opens that chat; a bolverse://connect link (e.g. scanned with the phone's
  // own camera app) connects straight away.
  useEffect(() => onNotificationTap(openChat), []);
  useEffect(() => {
    const handle = async (url: string | null) => {
      const token = url ? inviteToken(url) : null;
      if (!token) return;
      const err = await join({ token });
      if (err) Alert.alert("Couldn't connect", err);
    };
    void Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener("url", ({ url }) => void handle(url));
    return () => sub.remove();
  }, []);
  const [askKey, setAskKey] = useState(0);
  const owner = account.user?.id ?? "open";

  const tabs: { id: Tab; label: string; Icon: typeof Icons.Chat }[] = [
    { id: "ask", label: "Ask", Icon: Icons.Sparkle }, { id: "converse", label: "Talk", Icon: Icons.Chat },
    { id: "connect", label: "Connect", Icon: Icons.Qr },
    { id: "history", label: "History", Icon: Icons.History }, { id: "profile", label: "Profile", Icon: Icons.User },
  ];

  return (
    <>
      <View style={{ flex: 1 }}>
        {tab === "ask" && <Ask key={askKey} prefs={prefs} updatePrefs={updatePrefs} owner={owner} open={openThread} />}
        {tab === "converse" && <Converse profile={prefs} update={updatePrefs} owner={owner} />}
        {tab === "connect" && <Connect rate={prefs.rate} />}
        {tab === "history" && <History owner={owner} rate={prefs.rate} onContinue={(t) => {
          if (t.kind === "ask") { setOpenThread(t); setAskKey((k) => k + 1); setTab("ask"); }
        }} />}
        {tab === "profile" && <ProfileScreen prefs={prefs} updatePrefs={updatePrefs} owner={owner} />}
      </View>
      <SafeAreaView edges={["bottom"]} style={styles.tabwrap}>
        <View style={[styles.tabbar, { backgroundColor: c.surface, borderColor: c.line }]}>
          {tabs.map(({ id, label, Icon }) => {
            const active = tab === id;
            return (
              <Pressable key={id} style={styles.tab} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: active }}
                onPress={() => { stopSpeaking(); if (id === "ask" && tab !== "ask") setOpenThread(null); setTab(id); }}>
                <View style={[styles.pill, active && shadow(c.you)]}>
                  {active && <GradFill name="you" radius={15} />}
                  <View><Icon color={active ? "#fff" : c.muted} size={22} /></View>
                </View>
                {id === "connect" && unread > 0 && (
                  <View style={[styles.badge, { backgroundColor: c.danger, borderColor: c.surface }]}><Text style={styles.badgeText}>{unread > 99 ? "99+" : unread}</Text></View>
                )}
                <Text numberOfLines={1} style={{ fontSize: 11.5, color: active ? c.accent : c.muted, fontWeight: active ? "800" : "600" }}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  tabwrap: { paddingHorizontal: 12, paddingBottom: 8 },
  tabbar: { flexDirection: "row", borderWidth: 1, borderRadius: 24, padding: 6, shadowColor: "#15123D", shadowOpacity: 0.15, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 10 },
  tab: { flex: 1, alignItems: "center", paddingVertical: 3, gap: 3 },
  pill: { width: 46, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  badge: { position: "absolute", top: -2, left: "56%", minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, alignItems: "center", justifyContent: "center", borderWidth: 2 },
  badgeText: { color: "#fff", fontSize: 11, fontWeight: "700" },
});
