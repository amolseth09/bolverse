import { useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import {
  findLang, firstName, freeLeftText, leftToday, newId, otherThan, SUGGESTIONS,
  type AskResult, type Palette, type Profile, type Thread, type VoiceGender,
} from "@bolverse/shared";
import { AiTag, BotAvatar, GradFill, GradView, Icons, LangPicker, LevelBars, shadow } from "../components/Brand";
import { errorText, useApi } from "../lib/api";
import { useAccount } from "../lib/account";
import { speak, stopSpeaking, useRecorder } from "../lib/audio";
import { useHistory } from "../lib/history";
import { fonts, useColors } from "../lib/theme";

type AskThread = Extract<Thread, { kind: "ask" }>;

export function Ask({ prefs, updatePrefs, owner, open }: {
  prefs: Profile; updatePrefs: (p: Partial<Profile>) => void; owner: string; open?: AskThread | null;
}) {
  const c = useColors();
  const s = useMemo(() => makeStyles(c), [c]);
  const api = useApi();
  const recorder = useRecorder();
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
  const scroll = useRef<ScrollView>(null);
  const left = leftToday(account);
  const busy = thread.messages.some((m) => m.role === "bot" && !m.result && !m.error);

  function blank(): AskThread {
    const now = Date.now();
    return { id: newId(), kind: "ask", title: "", source: me.code, target: target.code, createdAt: now, updatedAt: now, messages: [] };
  }

  useEffect(() => () => { void recorder.cancel(); stopSpeaking(); }, []);
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setSeconds((x) => x + 1), 1000);
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

  async function run(input: Parameters<typeof api.ask>[2], shown: string, source = me.code) {
    if (left === 0) { openPaywall("translations"); return; }
    setNotice("");
    const userId = newId(), botId = newId(), now = Date.now();
    update((t) => ({ ...t, target: target.code, updatedAt: now, messages: [...t.messages,
      { id: userId, role: "user", at: now, text: shown }, { id: botId, role: "bot", at: now }] }));
    try {
      const r: AskResult = await api.ask(source, target.code, input);
      update((t) => ({ ...t, updatedAt: Date.now(), title: t.title || r.question,
        messages: t.messages.map((m) => m.id === userId ? { ...m, text: r.question } : m.id === botId ? { ...m, result: r, at: Date.now() } : m) }));
      void speak(api, r.translation, r.target, prefs.rate, r.voice_gender ?? voice);
      if (left !== null) void refresh();
    } catch (e) {
      if (handleError(e)) { update((t) => ({ ...t, messages: t.messages.filter((m) => m.id !== userId && m.id !== botId) })); return; }
      update((t) => ({ ...t, messages: t.messages.map((m) => m.id === botId ? { ...m, error: errorText(e) } : m) }));
    }
  }

  async function toggleMic() {
    if (recording) {
      setRecording(false);
      try { void run({ audio: await recorder.stop() }, "🎤 …"); } catch (e) { setNotice(errorText(e)); }
      return;
    }
    if (left === 0) { openPaywall("translations"); return; }
    stopSpeaking(); setNotice("");
    try { await recorder.start(); setSeconds(0); setRecording(true); } catch (e) { setNotice(errorText(e)); }
  }

  function send() {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    void run({ text: t }, t);
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
      <View style={s.head}>
        <View style={s.botId}>
          <BotAvatar size={42} thinking={busy} />
          <View>
            <View style={s.nameRow}><Text style={s.botName}>Bolverse</Text><AiTag /></View>
            <Text style={s.status}><Text style={{ color: c.ok }}>● </Text>{busy ? "Thinking…" : "Your AI interpreter"}</Text>
          </View>
        </View>
        <Pressable onPress={() => { stopSpeaking(); setThread(blank()); }} accessibilityRole="button" accessibilityLabel="New chat" style={s.newBtn}>
          <Icons.Plus color={c.ink} />
        </Pressable>
      </View>
      <View style={s.targetRow}>
        <Text style={s.targetLabel}>Translate to</Text>
        <LangPicker value={target.code} exclude={me.code} label="Translate to" onChange={(code) => updatePrefs({ askTarget: code })}>
          <View style={s.targetPill}><Icons.Globe color={c.accent} size={16} /><Text style={s.targetText}>{target.name}</Text><Text style={{ color: c.accent }}>▾</Text></View>
        </LangPicker>
      </View>

      <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={[s.messages, thread.messages.length === 0 && { flexGrow: 1, justifyContent: "flex-end" }]}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })} keyboardShouldPersistTaps="handled">
        {thread.messages.length === 0 && !recording && (
          <View style={s.hero}>
            <BotAvatar size={60} />
            <Text style={s.hi}>Hi{firstName(account) ? ` ${firstName(account)}` : ""} 👋</Text>
            <Text style={s.heroQ}>What would you like to say in <Text style={{ color: c.accent }}>{target.name}</Text>?</Text>
            <Text style={s.heroBody}>Speak or type in {me.name} (Hinglish works too). I'll translate it, say it out loud, and show you how to read it.</Text>
            <View style={s.tryRow}><Icons.Sparkle color={c.accent} size={15} /><Text style={s.tryLabel}>TRY ONE</Text></View>
            <View style={s.chips}>
              {SUGGESTIONS.slice(0, 4).map((q) => (
                <Pressable key={q} style={({ pressed }) => [s.chip, pressed && { borderColor: c.you, backgroundColor: c.youSoft }]} onPress={() => void run({ text: q }, q, "en-US")}>
                  <Text style={s.chipText}>{q}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}
        {thread.messages.map((m) => m.role === "user" ? (
          <View key={m.id} style={s.msgUser}><GradView style={[s.userBubble, shadow(c.you)]}><Text style={s.userText}>{m.text}</Text></GradView></View>
        ) : (
          <View key={m.id} style={s.msgBot}>
            <BotAvatar size={30} thinking={!m.result && !m.error} />
            {m.result ? <Answer result={m.result} me={me.name} rate={prefs.rate} voice={voice} />
              : m.error ? <View style={s.botBubble}><Text style={{ color: c.danger }}>{m.error}</Text></View>
              : <View style={s.botBubble}><Text style={s.small}>Thinking…</Text></View>}
          </View>
        ))}
        {recording && (
          <View style={s.msgUser}>
            <GradView style={s.userBubble}>
              <View style={s.listenRow}><LevelBars level={recorder.level} color="#fff" /><Text style={s.userText}>Listening… {seconds}s</Text></View>
            </GradView>
          </View>
        )}
      </ScrollView>

      <View style={s.composer}>
        {!!notice && <Text style={s.notice}>{notice}</Text>}
        <View style={s.composerRow}>
          <Pressable style={({ pressed }) => [s.mic, !recording && shadow(c.you), recording && { backgroundColor: c.danger }, pressed && { transform: [{ scale: 0.94 }] }]}
            onPress={() => void toggleMic()} disabled={busy && !recording}
            accessibilityRole="button" accessibilityLabel={recording ? "Stop and translate" : `Speak in ${me.name}`}>
            {!recording && <GradFill name="you" radius={26} />}
            <View>{recording ? <Icons.Stop color="#fff" size={24} /> : <Icons.Mic color="#fff" size={26} />}</View>
          </Pressable>
          <TextInput style={s.input} value={text} onChangeText={setText} placeholder={`Type in ${me.name}`} placeholderTextColor={c.muted}
            onSubmitEditing={send} returnKeyType="send" />
          <Pressable style={[s.send, (!text.trim() || busy) && { opacity: 0.4 }]} onPress={send} disabled={!text.trim() || busy} accessibilityLabel="Translate">
            <Icons.Send color={c.bg} size={19} />
          </Pressable>
        </View>
        <Text style={s.hint}>
          {recording ? `Listening… ${seconds}s · tap ■ when you're done` : `Tap the mic and speak ${me.name}`}
          {left !== null && <Text style={{ fontWeight: "700", color: c.accent }}>{`  ·  ${freeLeftText(account)}`}</Text>}
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

function Answer({ result, me, rate, voice }: { result: AskResult; me: string; rate: number; voice: VoiceGender | null }) {
  const c = useColors();
  const s = useMemo(() => makeStyles(c), [c]);
  const api = useApi();
  const target = findLang(result.target);
  const gender = result.voice_gender ?? voice;
  return (
    <View style={[s.botBubble, s.answer]}>
      <View style={s.tryRow}><Icons.Sparkle color={c.accent} size={13} /><Text style={s.answerLang}>{target.name.toUpperCase()}</Text></View>
      <Text style={s.answerText}>{result.translation}</Text>
      {(!!result.native_reading || !!result.english_reading) && (
        <View style={s.readings}>
          {!!result.native_reading && <View><Text style={s.readingLabel}>Read it in {me}</Text><Text style={s.reading}>{result.native_reading}</Text></View>}
          {!!result.english_reading && <View><Text style={s.readingLabel}>In English letters</Text><Text style={s.reading}>{result.english_reading}</Text></View>}
        </View>
      )}
      <View style={s.actions}>
        <Pressable style={[s.action, { borderWidth: 0, overflow: "hidden" }]} onPress={() => void speak(api, result.translation, target.code, rate, gender)}>
          <GradFill name="you" />
          <View><Icons.Speaker color="#fff" size={18} /></View><Text style={[s.actionText, { color: "#fff" }]}>Play</Text>
        </Pressable>
        <Pressable style={s.action} onPress={() => void speak(api, result.translation, target.code, Math.max(0.6, rate * 0.7), gender)}>
          <Icons.Slow color={c.ink} /><Text style={s.actionText}>Slowly</Text>
        </Pressable>
        <Pressable style={s.action} onPress={() => void Share.share({ message: result.translation })}>
          <Icons.Copy color={c.ink} /><Text style={s.actionText}>Share</Text>
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6 },
  botId: { flexDirection: "row", alignItems: "center", gap: 10 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  botName: { fontFamily: fonts.display, fontSize: 20, color: c.ink },
  status: { fontSize: 13, color: c.muted },
  newBtn: { width: 42, height: 42, borderRadius: 21, borderWidth: 1.5, borderColor: c.line, backgroundColor: c.surface, alignItems: "center", justifyContent: "center" },
  targetRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingBottom: 10 },
  targetLabel: { color: c.muted, fontWeight: "700", fontSize: 13 },
  targetPill: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: c.youSoft, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14 },
  targetText: { color: c.accent, fontWeight: "800", fontSize: 15 },
  messages: { padding: 16, gap: 14 },
  hero: { gap: 4, paddingBottom: 6 },
  hi: { color: c.muted, fontSize: 18, fontWeight: "700", marginTop: 12 },
  heroQ: { fontFamily: fonts.display, color: c.ink, fontSize: 27, lineHeight: 32, letterSpacing: -0.5 },
  heroBody: { color: c.muted, fontSize: 16, lineHeight: 23, marginTop: 4 },
  tryRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 10 },
  tryLabel: { color: c.muted, fontSize: 12, fontWeight: "800", letterSpacing: 0.8 },
  msgBot: { flexDirection: "row", gap: 8, alignItems: "flex-end", maxWidth: "92%" },
  msgUser: { alignItems: "flex-end" },
  botBubble: { flexShrink: 1, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, borderRadius: 22, borderBottomLeftRadius: 8, padding: 14 },
  answer: { borderColor: c.you, borderWidth: 1.5 },
  userBubble: { maxWidth: "86%", borderRadius: 22, borderBottomRightRadius: 8, paddingVertical: 11, paddingHorizontal: 16 },
  userText: { color: "#fff", fontSize: 17 },
  listenRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  body: { color: c.ink, fontSize: 16, lineHeight: 23 },
  bold: { fontWeight: "700" },
  small: { color: c.muted, fontSize: 14 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
  chip: { borderWidth: 1.5, borderColor: c.line, backgroundColor: c.surface, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14 },
  chipText: { color: c.ink, fontSize: 14, fontWeight: "600" },
  answerLang: { color: c.accent, fontSize: 12, fontWeight: "800", letterSpacing: 0.8 },
  answerText: { color: c.ink, fontSize: 25, lineHeight: 33, fontWeight: "700", marginTop: 4, marginBottom: 8 },
  readings: { gap: 8, backgroundColor: c.bg, borderRadius: 14, padding: 10 },
  readingLabel: { color: c.muted, fontSize: 12, fontWeight: "800" },
  reading: { color: c.ink, fontSize: 17 },
  actions: { flexDirection: "row", gap: 8, marginTop: 12, flexWrap: "wrap" },
  action: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1.5, borderColor: c.line, borderRadius: 12, paddingVertical: 8, paddingHorizontal: 13 },
  actionText: { color: c.ink, fontWeight: "700", fontSize: 14 },
  composer: { paddingHorizontal: 14, paddingTop: 6, paddingBottom: 6 },
  composerRow: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, borderRadius: 999, padding: 6 },
  mic: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  input: { flex: 1, minWidth: 0, color: c.ink, paddingVertical: 10, paddingHorizontal: 6, fontSize: 16, textAlignVertical: "center" },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: c.ink, alignItems: "center", justifyContent: "center" },
  hint: { color: c.muted, fontSize: 13, textAlign: "center", marginTop: 6 },
  notice: { backgroundColor: c.highlight, color: c.ink, borderRadius: 14, padding: 10, marginBottom: 10, overflow: "hidden" },
});
