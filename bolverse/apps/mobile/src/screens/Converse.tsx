import { useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { findLang, freeLeftText, leftToday, newId, otherThan, type ConverseMessage, type Palette, type Profile, type Thread, type TranslateResult, type VoiceGender } from "@bolverse/shared";
import { GradView, Icons, LangPicker, LevelBars, shadow, TopBar } from "../components/Brand";
import { errorText, useApi } from "../lib/api";
import { useAccount } from "../lib/account";
import { useHistory } from "../lib/history";
import { speak, stopSpeaking, useRecorder } from "../lib/audio";
import { fonts, radius, useColors } from "../lib/theme";

type Side = "me" | "them";
interface Entry {
  id: string; who: Side; original: string; to: string; status: "working" | "done" | "error";
  translation?: string; romanized?: string; error?: string; gender?: VoiceGender | null;
}
type ConvThread = Extract<Thread, { kind: "converse" }>;

const MAX_SECONDS = 60;
let seq = 0;

export function Converse({ profile, update, owner }: { profile: Profile; update: (p: Partial<Profile>) => void; owner: string }) {
  const c = useColors();
  const s = useMemo(() => makeStyles(c), [c]);
  const api = useApi();
  const recorder = useRecorder();
  const { account, refresh, openPaywall, handleError } = useAccount();
  const { save } = useHistory(owner);
  const left = leftToday(account);
  const me = findLang(account.user?.language ?? profile.myLang);
  const myVoice: VoiceGender | null = account.user?.voice_gender ?? null;
  const [theirGender, setTheirGender] = useState<VoiceGender | "auto">("auto");
  const thread = useRef<ConvThread | null>(null);
  const them = findLang(otherThan(profile.myLang, profile.target));
  const [entries, setEntries] = useState<Entry[]>([]);
  const [recording, setRecording] = useState<Side | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [notice, setNotice] = useState("");
  const [typed, setTyped] = useState("");
  const [typeAs, setTypeAs] = useState<Side>("me");
  const scroll = useRef<ScrollView>(null);

  useEffect(() => () => { void recorder.cancel(); stopSpeaking(); }, []);
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setSeconds((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);
  useEffect(() => { if (recording && seconds >= MAX_SECONDS) void toggleMic(recording); }, [seconds]);

  const pair = (who: Side) => (who === "me" ? [me, them] : [them, me]);
  const genderFor = (who: Side) => (who === "me" ? myVoice : theirGender === "auto" ? null : theirGender);

  function remember(e: Entry) {
    const now = Date.now();
    const msg: ConverseMessage = { id: e.id, who: e.who, at: now, original: e.original, translation: e.translation ?? "",
      romanized: e.romanized ?? "", to: e.to, gender: e.gender ?? null };
    const t = thread.current ?? { id: newId(), kind: "converse" as const, title: e.original, source: me.code, target: them.code,
      createdAt: now, updatedAt: now, messages: [] };
    thread.current = { ...t, updatedAt: now, messages: [...t.messages, msg] };
    save(thread.current);
  }

  async function run(who: Side, placeholder: string, work: () => Promise<TranslateResult & { original?: string; speaker_gender?: VoiceGender | null }>) {
    const to = pair(who)[1];
    const id = String(++seq);
    setEntries((es) => [...es, { id, who, original: placeholder, to: to.code, status: "working" }]);
    try {
      const r = await work();
      const gender = r.speaker_gender ?? genderFor(who);
      const done: Entry = { id, who, to: to.code, original: r.original ?? placeholder, translation: r.translation,
        romanized: r.romanized, status: "done", gender };
      setEntries((es) => es.map((e) => (e.id === id ? done : e)));
      remember(done);
      if (who === "me" || profile.speakTheirs) void speak(api, r.translation, to.code, profile.rate, gender);
      if (left !== null) void refresh(); // keep the free counter current
    } catch (err) {
      if (handleError(err)) { setEntries((es) => es.filter((e) => e.id !== id)); return; }
      setEntries((es) => es.map((e) => (e.id === id ? { ...e, status: "error", error: errorText(err) } : e)));
    }
  }

  async function toggleMic(who: Side) {
    if (!recording && left === 0) { openPaywall("translations"); return; }
    if (recording) {
      const side = recording;
      setRecording(null);
      try {
        const file = await recorder.stop();
        const [from, to] = pair(side);
        void run(side, "…", () => api.converse(file, from.code, to.code, side, genderFor(side)));
      } catch (e) { setNotice(errorText(e)); }
      return;
    }
    stopSpeaking();
    setNotice("");
    try {
      await recorder.start();
    } catch (e) {
      setNotice(errorText(e));
      return;
    }
    setSeconds(0);
    setRecording(who);
  }

  function sendTyped() {
    const text = typed.trim();
    if (!text) return;
    if (left === 0) { openPaywall("translations"); return; }
    setTyped("");
    const [from, to] = pair(typeAs);
    void run(typeAs, text, async () => ({ original: text, ...(await api.translate(text, from.code, to.code, typeAs, genderFor(typeAs))) }));
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
      <TopBar />
      <View style={s.pairbar}>
        <GradView name="you" style={[s.side, { flex: 1 }, shadow(c.you)]}>
          <Text style={[s.who, { color: "#fff" }]}>YOU SPEAK</Text>
          <Text style={[s.lang, { color: "#fff" }]} numberOfLines={1}>{me.native}</Text>
          <Text style={[s.change, { color: "#fff" }]}>{myVoice === "male" ? "Male voice" : "Female voice"}</Text>
        </GradView>
        <View style={s.swap}><Icons.Swap color={c.accent} size={18} /></View>
        <LangPicker value={them.code} exclude={me.code} label="They speak" onChange={(code) => update({ target: code })} style={{ flex: 1 }}>
          <GradView name="them" style={s.side}>
            <Text style={[s.who, { color: c.themInk }]}>THEY SPEAK</Text>
            <Text style={[s.lang, { color: c.themInk }]} numberOfLines={1}>{them.native}</Text>
            <Text style={[s.change, { color: c.themInk }]}>Change ▾</Text>
          </GradView>
        </LangPicker>
      </View>
      <View style={s.genderRow}>
        <Text style={s.genderLabel}>Their voice</Text>
        <View style={s.genderSeg}>
          {(["auto", "female", "male"] as const).map((g) => (
            <Pressable key={g} onPress={() => setTheirGender(g)} accessibilityRole="button" accessibilityState={{ selected: theirGender === g }}
              style={[s.gBtn, theirGender === g && { backgroundColor: c.themSoft, borderColor: c.them }]}>
              <Text style={{ color: c.ink, fontWeight: theirGender === g ? "800" : "600", fontSize: 13 }}>{g === "auto" ? "Auto" : g === "female" ? "Female" : "Male"}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={s.transcript}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
        {entries.length === 0 && !recording && (
          <View style={s.empty}>
            <Text style={s.emptyTitle}>Talk face to face,{"\n"}<Text style={{ color: c.accent }}>AI in the middle.</Text></Text>
            {[`Tap I speak and talk in ${me.name}.`, `Bolverse says it aloud in ${them.name}, in your voice.`, "Hand over the phone: they tap They speak to reply."].map((t, i) => (
              <View key={i} style={s.step}>
                <GradView style={s.stepNum}><Text style={s.stepNumText}>{i + 1}</Text></GradView>
                <Text style={s.stepText}>{t}</Text>
              </View>
            ))}
          </View>
        )}
        {entries.map((e) => {
          const mine = e.who === "me";
          const fg = mine ? "#fff" : c.themInk;
          return (
            <GradView key={e.id} name={mine ? "you" : "them"} style={[s.bubble, mine ? s.bubbleMe : s.bubbleThem]}>
              <Text style={[s.said, { color: fg }]}>{e.original}</Text>
              {e.status === "working" && <Text style={[s.tr, { color: fg }]}>…</Text>}
              {e.status === "error" && <Text style={{ color: fg, fontWeight: "600", fontSize: 14 }}>{e.error}</Text>}
              {e.status === "done" && (
                <View style={s.row}>
                  <View style={{ flexShrink: 1 }}>
                    <Text style={[s.tr, { color: fg }]}>{e.translation}</Text>
                    {!!e.romanized && <Text style={[s.rom, { color: fg }]}>{e.romanized}</Text>}
                  </View>
                  <Pressable accessibilityLabel="Play again" hitSlop={10}
                    onPress={() => void speak(api, e.translation ?? "", e.to, profile.rate, e.gender)}>
                    <Icons.Speaker color={fg} />
                  </Pressable>
                </View>
              )}
            </GradView>
          );
        })}
        {recording && (
          <GradView name={recording === "me" ? "you" : "them"} style={[s.bubble, recording === "me" ? s.bubbleMe : s.bubbleThem]}>
            <View style={s.listenRow}>
              <LevelBars level={recorder.level} color={recording === "me" ? "#fff" : c.themInk} />
              <Text style={[s.tr, { color: recording === "me" ? "#fff" : c.themInk }]}>Listening… 0:{String(seconds).padStart(2, "0")}</Text>
            </View>
          </GradView>
        )}
      </ScrollView>

      <View style={s.controls}>
        {!!notice && <Text style={s.notice}>{notice}</Text>}
        <View style={s.mics}>
          {(["me", "them"] as Side[]).map((side) => {
            const [from, to] = pair(side);
            const live = recording === side;
            const fg = side === "me" ? "#fff" : c.themInk;
            return (
              <Pressable key={side} accessibilityRole="button" accessibilityLabel={side === "me" ? "I speak" : "They speak"} accessibilityState={{ selected: live }}
                disabled={!!recording && !live} onPress={() => void toggleMic(side)}
                style={({ pressed }) => [s.micWrap, side === "me" ? shadow(c.you) : shadow(c.them),
                  { opacity: !!recording && !live ? 0.45 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] },
                  live && { borderWidth: 4, borderColor: c.danger }]}>
                <GradView name={side === "me" ? "you" : "them"} style={s.mic}>
                  <View style={[s.micIcon, live && { backgroundColor: c.danger }]}>{live ? <Icons.Stop color="#fff" size={22} /> : <Icons.Mic color={fg} size={22} />}</View>
                  <Text style={[s.micBig, { color: fg }]}>{live ? "Tap to send" : side === "me" ? "I speak" : "They speak"}</Text>
                  <Text style={{ color: fg, fontSize: 13, opacity: 0.9 }}>{from.name} to {to.name}</Text>
                </GradView>
              </Pressable>
            );
          })}
        </View>
        <View style={s.typerow}>
          <View style={s.seg}>
            {(["me", "them"] as Side[]).map((side) => (
              <Pressable key={side} onPress={() => setTypeAs(side)} accessibilityState={{ selected: typeAs === side }}
                style={[s.segBtn, typeAs === side && { backgroundColor: c.you }]}>
                <Text style={{ color: typeAs === side ? "#fff" : c.muted, fontWeight: "700", fontSize: 14 }}>{side === "me" ? "Me" : "Them"}</Text>
              </Pressable>
            ))}
          </View>
          <TextInput style={s.input} value={typed} onChangeText={setTyped} onSubmitEditing={sendTyped} returnKeyType="send"
            placeholder={`Type in ${(typeAs === "me" ? me : them).name}`} placeholderTextColor={c.muted} />
          <Pressable onPress={sendTyped} disabled={!typed.trim()} accessibilityLabel="Say it" style={[s.sendBtn, !typed.trim() && { opacity: 0.4 }]}>
            <Icons.Send color={c.bg} size={18} />
          </Pressable>
        </View>
        {left !== null && (
          <Text style={s.quota} accessibilityLiveRegion="polite">
            {left === 0 ? "No free translations left. " : `${freeLeftText(account)}. `}
            <Text style={s.quotaLink} onPress={() => openPaywall(left === 0 ? "translations" : "upgrade")}>Get unlimited</Text>
          </Text>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  pairbar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  side: { borderRadius: 20, paddingVertical: 10, paddingHorizontal: 14 },
  swap: { width: 34, height: 34, borderRadius: 17, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, alignItems: "center", justifyContent: "center" },
  who: { fontSize: 11, fontWeight: "800", letterSpacing: 0.6, opacity: 0.9 },
  lang: { fontFamily: fonts.display, fontSize: 18 },
  change: { fontSize: 12, fontWeight: "700", opacity: 0.85 },
  transcript: { paddingHorizontal: 16, paddingVertical: 8, gap: 12, flexGrow: 1 },
  empty: { flex: 1, justifyContent: "center", paddingVertical: 20, gap: 10 },
  emptyTitle: { fontFamily: fonts.display, fontSize: 26, lineHeight: 31, color: c.ink, marginBottom: 6, letterSpacing: -0.5 },
  step: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, borderRadius: 18, padding: 12 },
  stepNum: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  stepNumText: { color: "#fff", fontWeight: "800", textAlign: "center" },
  stepText: { flex: 1, color: c.ink, fontSize: 15, lineHeight: 21 },
  emptyText: { color: c.muted, fontSize: 16, lineHeight: 24 },
  bubble: { maxWidth: "86%", paddingVertical: 10, paddingHorizontal: 16, borderRadius: 22 },
  bubbleMe: { alignSelf: "flex-end", borderBottomRightRadius: 8 },
  bubbleThem: { alignSelf: "flex-start", borderBottomLeftRadius: 8 },
  said: { fontSize: 14, opacity: 0.85 },
  tr: { fontSize: 21, lineHeight: 28, fontWeight: "700", marginTop: 2 },
  rom: { fontSize: 14, fontStyle: "italic", opacity: 0.85 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  listenRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  controls: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6 },
  notice: { backgroundColor: c.highlight, color: c.ink, borderRadius: 14, padding: 10, marginBottom: 10, fontSize: 15, overflow: "hidden" },
  mics: { flexDirection: "row", gap: 10 },
  micWrap: { flex: 1, borderRadius: radius.tile },
  mic: { borderRadius: radius.tile, padding: 14, minHeight: 112 },
  micIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(255,255,255,0.28)", alignItems: "center", justifyContent: "center", marginBottom: 10 },
  micBig: { fontFamily: fonts.display, fontSize: 19, letterSpacing: -0.4 },
  typerow: { flexDirection: "row", gap: 8, marginTop: 10, alignItems: "center", backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, borderRadius: 999, padding: 5 },
  seg: { flexDirection: "row", backgroundColor: c.bg, borderRadius: 999, padding: 2 },
  segBtn: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999 },
  sendBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: c.ink, alignItems: "center", justifyContent: "center" },
  genderRow: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", paddingHorizontal: 16, paddingBottom: 6, gap: 8 },
  genderLabel: { color: c.muted, fontSize: 13, fontWeight: "700" },
  genderSeg: { flexDirection: "row", alignItems: "center", gap: 4 },
  gBtn: { borderWidth: 1.5, borderColor: c.line, backgroundColor: c.surface, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 11 },
  quota: { color: c.muted, fontSize: 13, textAlign: "center", marginTop: 6 },
  quotaLink: { color: c.accent, fontWeight: "700", textDecorationLine: "underline" },
  input: { flex: 1, minWidth: 0, color: c.ink, paddingVertical: 8, paddingHorizontal: 6, fontSize: 16, textAlignVertical: "center" },
});
