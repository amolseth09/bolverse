import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import Svg, { Path, Rect } from "react-native-svg";
import { dayLabel, findLang, inviteToken, qrMatrix, qrPath, type Chat, type ChatMessage, type Invite, type Palette } from "@bolverse/shared";
import { BotAvatar, Btn, GradFill, GradView, Icons, LevelBars, shadow } from "../components/Brand";
import { Sheet } from "../components/Sheet";
import { errorText, useApi } from "../lib/api";
import { useAccount } from "../lib/account";
import { speak, stopSpeaking, useRecorder } from "../lib/audio";
import { useChats } from "../lib/chats";
import { fonts, useColors } from "../lib/theme";

const MAX_SECONDS = 30;

/** Connect: chat with someone on their own phone; each of you speaks your own language. */
export function Connect({ rate }: { rate: number }) {
  const c = useColors();
  const s = useMemo(() => makeStyles(c), [c]);
  const { account, openLogin } = useAccount();
  const { chats, openId, setOpenId } = useChats();
  const open = chats.find((x) => x.id === openId) ?? null;
  useEffect(() => () => setOpenId(null), []);
  if (!account.user) {
    return (
      <ScrollView contentContainerStyle={s.page}>
        <Text style={s.h1}>Connect</Text>
        <Text style={s.lead}>Chat with someone on their own phone, each in your own language. Bolverse AI translates both ways.</Text>
        <View style={s.empty}>
          <BotAvatar size={52} />
          <Text style={[s.lead, { textAlign: "center" }]}>Log in with your mobile number to connect with people.</Text>
          <Btn kind="primary" label="Log in or sign up" onPress={() => openLogin()} />
        </View>
      </ScrollView>
    );
  }
  return open ? <ChatView chat={open} rate={rate} onBack={() => setOpenId(null)} /> : <ChatList chats={chats} onOpen={setOpenId} />;
}

/** Joins with a scanned QR text or a typed code; used by the scanner, the code box and app links. */
export function useJoin(onJoined: (id: string) => void) {
  const api = useApi();
  const { refresh } = useChats();
  return async (input: { token: string } | { code: string }): Promise<string | null> => {
    try {
      const r = await api.connectJoin(input);
      await refresh();
      onJoined(r.connection.id);
      return null;
    } catch (e) {
      return errorText(e);
    }
  };
}

function ChatList({ chats, onOpen }: { chats: Chat[]; onOpen: (id: string) => void }) {
  const c = useColors();
  const s = useMemo(() => makeStyles(c), [c]);
  const api = useApi();
  const { remove } = useChats();
  const join = useJoin(onOpen);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [scanning, setScanning] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function showQr() {
    setError(""); setBusy(true);
    try { setInvite(await api.connectInvite()); } catch (e) { setError(errorText(e)); }
    setBusy(false);
  }
  async function joinCode() {
    const v = code.trim().replace(/\s/g, "").toUpperCase();
    if (v.length < 6) { setError("Type the 6-character code under their QR."); return; }
    setBusy(true); setError("");
    const err = await join({ code: v });
    if (err) setError(err); else setCode("");
    setBusy(false);
  }

  return (
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      <Text style={s.h1}>Connect</Text>
      <Text style={s.lead}>Chat with someone on their own phone. You each speak your language; Bolverse AI translates both ways and reads it aloud.</Text>
      <View style={s.bigRow}>
        <Pressable style={({ pressed }) => [s.bigWrap, shadow(c.you), pressed && { transform: [{ scale: 0.97 }] }]} onPress={() => void showQr()} disabled={busy} accessibilityRole="button" accessibilityLabel="Show my QR code">
          <GradView name="you" style={s.big}>
            <View style={s.bigIcon}><Icons.Qr color="#fff" size={26} /></View>
            <Text style={[s.bigText, { color: "#fff" }]}>Show my QR</Text>
            <Text style={[s.bigSub, { color: "#fff" }]}>They scan it</Text>
          </GradView>
        </Pressable>
        <Pressable style={({ pressed }) => [s.bigWrap, shadow(c.them), pressed && { transform: [{ scale: 0.97 }] }]} onPress={() => { setError(""); setScanning(true); }} accessibilityRole="button" accessibilityLabel="Scan their QR code">
          <GradView name="them" style={s.big}>
            <View style={[s.bigIcon, { backgroundColor: "rgba(255,255,255,0.45)" }]}><Icons.Scan color={c.themInk} size={26} /></View>
            <Text style={[s.bigText, { color: c.themInk }]}>Scan QR</Text>
            <Text style={[s.bigSub, { color: c.themInk }]}>Scan theirs</Text>
          </GradView>
        </Pressable>
      </View>
      <View style={s.codeRow}>
        <View style={s.codeIcon}><Icons.Link color={c.accent} size={20} /></View>
        <TextInput style={s.codeInput} value={code} onChangeText={(t) => setCode(t.toUpperCase())} placeholder="Have a code? Type it"
          placeholderTextColor={c.muted} autoCapitalize="characters" autoCorrect={false} maxLength={8} onSubmitEditing={() => void joinCode()} />
        <Btn kind="primary" label="Join" onPress={() => void joinCode()} disabled={busy} style={{ paddingVertical: 9, borderRadius: 999 }} />
      </View>
      {!!error && <Text style={s.error} accessibilityLiveRegion="polite">{error}</Text>}

      <Text style={s.h2}>Your chats</Text>
      {chats.length === 0 && (
        <View style={s.empty}><BotAvatar size={52} /><Text style={[s.lead, { textAlign: "center" }]}>No chats yet. Show your QR code to a friend with Bolverse and start talking in your own languages.</Text></View>
      )}
      {chats.map((chat) => {
        const last = [...chat.messages].reverse().find((m) => m.kind === "text" || m.kind === "voice");
        return (
          <Pressable key={chat.id} style={[s.row, chat.ended && { opacity: 0.6 }]} onPress={() => onOpen(chat.id)}
            onLongPress={() => chat.ended && Alert.alert(`Delete chat with ${chat.peer.name}?`, "It's removed from this phone only.", [
              { text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: () => remove(chat.id) }])}
            accessibilityRole="button" accessibilityLabel={`Chat with ${chat.peer.name}${chat.unread ? `, ${chat.unread} unread` : ""}`}>
            <GradView name="them" style={s.avatar}><Text style={s.avatarText}>{chat.peer.name.slice(0, 1).toUpperCase()}</Text></GradView>
            <View style={{ flex: 1 }}>
              <Text style={s.name} numberOfLines={1}>{chat.peer.name}</Text>
              <Text style={s.small} numberOfLines={1}>{chat.ended ? "Disconnected" : findLang(chat.peer.language).name}{last ? ` · ${last.from_me ? "You: " + last.original : last.translation}` : ""}</Text>
            </View>
            {chat.unread > 0 && <GradView style={s.unread}><Text style={s.unreadText}>{chat.unread}</Text></GradView>}
          </Pressable>
        );
      })}
      {invite && <QrSheet invite={invite} onNew={() => void showQr()} onClose={() => setInvite(null)} />}
      {scanning && <Scanner onClose={() => setScanning(false)} onCode={async (text) => {
        const token = inviteToken(text);
        if (!token) return "That isn't a Bolverse QR code.";
        const err = await join({ token });
        if (!err) setScanning(false);
        return err;
      }} />}
    </ScrollView>
  );
}

function QrSheet({ invite, onNew, onClose }: { invite: Invite; onNew: () => void; onClose: () => void }) {
  const c = useColors();
  const s = useMemo(() => makeStyles(c), [c]);
  const { chats, refresh } = useChats();
  const known = useRef(new Set(chats.map((x) => x.id)));
  const [left, setLeft] = useState(invite.expires_in);
  const matrix = useMemo(() => qrMatrix(invite.qr), [invite.qr]);
  useEffect(() => {
    setLeft(invite.expires_in);
    const t = setInterval(() => setLeft((v) => Math.max(0, v - 1)), 1000);
    const p = setInterval(() => void refresh(), 2000);
    return () => { clearInterval(t); clearInterval(p); };
  }, [invite]);
  const joined = chats.find((x) => !known.current.has(x.id) && !x.ended);
  useEffect(() => { if (joined) onClose(); }, [joined]);
  const n = matrix.length;
  return (
    <Sheet title="Let them scan this" onClose={onClose}>
      <Text style={s.lead}>It works once, for {Math.ceil(invite.expires_in / 60)} minutes. Their Bolverse app or phone camera can scan it.</Text>
      <View style={s.qrBox}>
        {left > 0 ? (
          <GradView name="aurora" style={s.qrFrame}><View style={s.qrInner}><Svg width={236} height={236} viewBox={`-2 -2 ${n + 4} ${n + 4}`} accessibilityLabel="QR code to connect">
            <Rect x={-2} y={-2} width={n + 4} height={n + 4} fill="#FFFFFF" />
            <Path d={qrPath(matrix)} fill="#15123D" />
          </Svg></View></GradView>
        ) : <Text style={s.lead}>This code has expired.</Text>}
      </View>
      <Text style={s.code}>Or type: <Text style={s.codeBold}>{invite.code}</Text></Text>
      <Text style={[s.small, { textAlign: "center" }]} accessibilityLiveRegion="polite">
        {left > 0 ? `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "Make a new one to connect."}
      </Text>
      <View style={{ flexDirection: "row", gap: 10, justifyContent: "center", marginTop: 14 }}>
        <Btn kind="ghost" label="New code" onPress={onNew} />
        <Btn kind="ghost" label="Close" onPress={onClose} />
      </View>
    </Sheet>
  );
}

function Scanner({ onClose, onCode }: { onClose: () => void; onCode: (text: string) => Promise<string | null> }) {
  const c = useColors();
  const s = useMemo(() => makeStyles(c), [c]);
  const [permission, requestPermission] = useCameraPermissions();
  const [message, setMessage] = useState("");
  const handling = useRef(false);
  useEffect(() => { if (permission && !permission.granted && permission.canAskAgain) void requestPermission(); }, [permission]);

  async function scanned(data: string) {
    if (handling.current) return;
    handling.current = true;
    setMessage("Connecting…");
    const err = await onCode(data);
    if (err) { setMessage(err); setTimeout(() => { handling.current = false; }, 2000); }
  }

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        {permission?.granted ? (
          <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => void scanned(data)} />
        ) : (
          <View style={s.camOff}>
            <Text style={s.camText}>Bolverse needs the camera to scan their QR code.</Text>
            {permission && !permission.canAskAgain
              ? <Text style={s.camText}>Allow the camera for Bolverse in your phone's Settings, or type their code instead.</Text>
              : <Btn kind="primary" label="Allow camera" onPress={() => void requestPermission()} />}
          </View>
        )}
        <View style={s.camFrame} pointerEvents="none" />
        <View style={s.camBar}>
          <Text style={s.camText}>{message || "Point the camera at their Bolverse QR code."}</Text>
          <Btn kind="onPrimary" label="Cancel" onPress={onClose} style={{ alignSelf: "center" }} />
        </View>
      </View>
    </Modal>
  );
}

function ChatView({ chat, rate, onBack }: { chat: Chat; rate: number; onBack: () => void }) {
  const c = useColors();
  const s = useMemo(() => makeStyles(c), [c]);
  const api = useApi();
  const { account, openPaywall, refresh: refreshAccount } = useAccount();
  const { send: sendMessage, retry, ended } = useChats();
  const recorder = useRecorder();
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const scroll = useRef<ScrollView>(null);
  const me = findLang(account.user?.language);
  const them = findLang(chat.peer.language);

  useEffect(() => { if (!recording) return; const t = setInterval(() => setSeconds((v) => v + 1), 1000); return () => clearInterval(t); }, [recording]);
  useEffect(() => { if (recording && seconds >= MAX_SECONDS) void toggleMic(); }, [seconds]);
  useEffect(() => () => { void recorder.cancel(); }, []);

  async function send(input: Parameters<typeof api.connectSend>[1]) {
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
      setRecording(false);
      try { await send({ audio: await recorder.stop() }); } catch (e) { setError(errorText(e)); }
      return;
    }
    stopSpeaking(); setError("");
    try { await recorder.start(); setSeconds(0); setRecording(true); } catch (e) { setError(errorText(e)); }
  }
  function submit() {
    const t = text.trim();
    if (!t) return;
    setText("");
    void send({ text: t });
  }
  function disconnect() {
    Alert.alert(`Disconnect from ${chat.peer.name}?`, "To talk again, one of you will need to show a new QR code.", [
      { text: "Cancel", style: "cancel" },
      { text: "Disconnect", style: "destructive", onPress: async () => { try { await api.disconnect(chat.id); } catch { /* already gone */ } ended(chat.id); } },
    ]);
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
      <View style={s.head}>
        <Pressable onPress={onBack} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back to chats"><Icons.Back color={c.ink} size={22} /></Pressable>
        <GradView name="them" style={s.avatar}><Text style={s.avatarText}>{chat.peer.name.slice(0, 1).toUpperCase()}</Text></GradView>
        <View style={{ flex: 1 }}>
          <Text style={s.name} numberOfLines={1}>{chat.peer.name}</Text>
          <Text style={s.small} numberOfLines={1}>{them.name} ⇄ {me.name}</Text>
        </View>
        {!chat.ended && (
          <Pressable onPress={disconnect} style={s.disc} accessibilityRole="button" accessibilityLabel="Disconnect">
            <Icons.Unlink color={c.danger} size={18} /><Text style={{ color: c.danger, fontWeight: "600" }}>Disconnect</Text>
          </Pressable>
        )}
      </View>
      <ScrollView ref={scroll} contentContainerStyle={s.msgs} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
        {chat.messages.map((m, i) => <Bubble key={`${m.client_id ?? m.id}-${i}`} m={m} prev={chat.messages[i - 1]} name={chat.peer.name} rate={rate} onRetry={onRetry} />)}
        {recording && (
          <GradView style={[s.bubble, s.mine]}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <LevelBars level={recorder.level} color="#fff" /><Text style={[s.tr, { color: "#fff" }]}>Listening… 0:{String(seconds).padStart(2, "0")}</Text>
            </View>
          </GradView>
        )}
      </ScrollView>
      {!!error && <Text style={[s.error, { paddingHorizontal: 16 }]}>{error}</Text>}
      {chat.ended ? (
        <Text style={s.notice}>This chat was disconnected. To talk again, one of you shows a new QR code from Connect.</Text>
      ) : (
        <View style={s.compose}>
          <Pressable onPress={() => void toggleMic()} style={[s.mic, recording ? { backgroundColor: c.danger } : shadow(c.you)]}
            accessibilityRole="button" accessibilityLabel={recording ? "Stop and send" : `Speak in ${me.name}`}>
            {!recording && <GradFill name="you" />}
            <View>{recording ? <Icons.Stop color="#fff" size={22} /> : <Icons.Mic color="#fff" size={24} />}</View>
          </Pressable>
          <TextInput style={s.input} value={text} onChangeText={setText} placeholder={`Type in ${me.name}`} placeholderTextColor={c.muted}
            editable={!recording} onSubmitEditing={submit} returnKeyType="send" />
          <Pressable onPress={submit} disabled={!text.trim()} style={[s.send, { opacity: text.trim() ? 1 : 0.4 }]} accessibilityRole="button" accessibilityLabel="Send">
            <Icons.Send color={c.bg} size={19} />
          </Pressable>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const STATUS_TEXT = { sending: "Sending…", sent: "Sent ✓", delivered: "Delivered ✓✓", failed: "Not sent" } as const;

function Bubble({ m, prev, name, rate, onRetry }: {
  m: ChatMessage; prev?: ChatMessage; name: string; rate: number; onRetry: (clientId: string) => void;
}) {
  const c = useColors();
  const s = useMemo(() => makeStyles(c), [c]);
  const api = useApi();
  const day = dayLabel(Date.parse(m.at));
  const showDay = !prev || dayLabel(Date.parse(prev.at)) !== day;
  if (m.kind === "joined" || m.kind === "ended") {
    return <Text style={s.system}>{m.kind === "joined" ? `${name} connected with you` : `${m.from_me ? "You" : name} disconnected`}</Text>;
  }
  const mine = m.from_me;
  const ink = mine ? "#fff" : c.themInk;
  return (
    <>
      {showDay && <Text style={s.system}>{day}</Text>}
      <Pressable style={[s.bubble, mine ? s.mine : s.theirs, { overflow: "hidden" }, m.status === "sending" && { opacity: 0.75 },
        m.status === "failed" && { borderWidth: 2, borderColor: c.danger }]} disabled={mine}
        onPress={() => void speak(api, m.translation, m.target, rate, m.gender)} accessibilityHint={mine ? undefined : "Plays it again"}>
        <GradFill name={mine ? "you" : "them"} />
        <Text style={[s.tr, { color: ink, position: "relative" }]}>{mine ? m.original : m.translation}</Text>
        {!!(mine ? m.translation : m.original) && (
          <Text style={{ position: "relative", color: ink, opacity: 0.8, fontSize: 14, marginTop: 4 }}>{mine ? `They hear: ${m.translation}` : `They said: ${m.original}`}</Text>
        )}
        {m.status === "failed" && !!m.error && <Text style={{ position: "relative", color: ink, fontSize: 13, marginTop: 4, fontWeight: "700" }}>{m.error}</Text>}
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 4, gap: 10 }}>
          <Text style={{ color: ink, opacity: 0.85, fontSize: 12 }} accessibilityLiveRegion="polite">
            {m.kind === "voice" ? "🎙 " : ""}{new Date(m.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
            {mine && m.status ? <Text style={{ fontWeight: "800" }}>{` · ${STATUS_TEXT[m.status]}`}</Text> : null}
          </Text>
          {!mine && <View><Icons.Speaker color={ink} size={18} /></View>}
          {mine && m.status === "failed" && !!m.client_id && (
            <Pressable onPress={() => onRetry(m.client_id!)} accessibilityRole="button" accessibilityLabel="Retry sending"
              style={{ backgroundColor: "#fff", borderRadius: 999, paddingVertical: 4, paddingHorizontal: 12 }}>
              <Text style={{ color: c.danger, fontWeight: "800", fontSize: 13 }}>Retry</Text>
            </Pressable>
          )}
        </View>
      </Pressable>
    </>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  page: { padding: 20, paddingBottom: 40 },
  h1: { fontFamily: fonts.display, fontSize: 30, color: c.ink, marginBottom: 4, letterSpacing: -0.6 },
  h2: { fontFamily: fonts.displayBold, fontSize: 20, color: c.ink, marginTop: 26, marginBottom: 10 },
  lead: { color: c.muted, fontSize: 16, lineHeight: 23 },
  small: { color: c.muted, fontSize: 13 },
  error: { color: c.danger, marginTop: 10 },
  bigRow: { flexDirection: "row", gap: 12, marginTop: 18 },
  bigWrap: { flex: 1, borderRadius: 24 },
  big: { borderRadius: 24, padding: 16, minHeight: 128 },
  bigIcon: { width: 46, height: 46, borderRadius: 16, backgroundColor: "rgba(255,255,255,0.22)", alignItems: "center", justifyContent: "center", marginBottom: 16 },
  bigText: { fontFamily: fonts.display, fontSize: 18 },
  bigSub: { fontSize: 13, opacity: 0.9 },
  codeRow: { flexDirection: "row", gap: 8, marginTop: 12, alignItems: "center", backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, borderRadius: 999, padding: 5 },
  codeIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: c.youSoft, alignItems: "center", justifyContent: "center" },
  codeInput: { flex: 1, minWidth: 0, color: c.ink, paddingHorizontal: 4, paddingVertical: 8, fontSize: 16, letterSpacing: 1 },
  empty: { alignItems: "center", gap: 10, paddingVertical: 24 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, borderRadius: 20, padding: 12, marginBottom: 8 },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  avatarText: { fontFamily: fonts.display, fontSize: 19, color: c.themInk, textAlign: "center" },
  name: { color: c.ink, fontWeight: "700", fontSize: 16 },
  unread: { borderRadius: 999, minWidth: 24, height: 24, paddingHorizontal: 7, alignItems: "center", justifyContent: "center" },
  unreadText: { color: "#fff", fontWeight: "800", fontSize: 13, textAlign: "center" },
  qrBox: { alignItems: "center", marginVertical: 14 },
  qrFrame: { borderRadius: 26, padding: 3 },
  qrInner: { backgroundColor: "#fff", borderRadius: 23, padding: 8 },
  code: { textAlign: "center", color: c.ink, fontSize: 16 },
  codeBold: { fontFamily: fonts.display, fontSize: 26, letterSpacing: 4, color: c.accent },
  camOff: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  camFrame: { position: "absolute", top: "28%", left: "15%", right: "15%", aspectRatio: 1, borderWidth: 3, borderColor: c.them, borderRadius: 24 },
  camBar: { position: "absolute", left: 0, right: 0, bottom: 0, padding: 24, paddingBottom: 44, gap: 14, backgroundColor: "rgba(0,0,0,0.6)" },
  camText: { color: "#fff", fontSize: 16, textAlign: "center", lineHeight: 22 },
  head: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.line },
  disc: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1.5, borderColor: c.line, backgroundColor: c.surface, borderRadius: 999, paddingVertical: 7, paddingHorizontal: 12 },
  msgs: { padding: 14, gap: 10 },
  system: { alignSelf: "center", color: c.muted, fontSize: 12, fontWeight: "700", backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 3, overflow: "hidden" },
  bubble: { maxWidth: "86%", borderRadius: 22, paddingVertical: 10, paddingHorizontal: 14 },
  mine: { alignSelf: "flex-end", borderBottomRightRadius: 8 },
  theirs: { alignSelf: "flex-start", borderBottomLeftRadius: 8 },
  tr: { fontSize: 19, fontWeight: "700", lineHeight: 26 },
  notice: { backgroundColor: c.highlight, color: c.ink, margin: 14, borderRadius: 14, padding: 12, overflow: "hidden" },
  compose: { flexDirection: "row", alignItems: "center", gap: 8, padding: 6, marginHorizontal: 12, marginBottom: 6, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, borderRadius: 999 },
  mic: { width: 50, height: 50, borderRadius: 25, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  input: { flex: 1, color: c.ink, paddingHorizontal: 6, paddingVertical: 10, fontSize: 16 },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: c.ink, alignItems: "center", justifyContent: "center" },
});
