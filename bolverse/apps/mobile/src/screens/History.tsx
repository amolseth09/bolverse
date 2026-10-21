import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { dayLabel, findLang, type Palette, type Thread } from "@bolverse/shared";
import { BotAvatar, Btn, Icons, GradFill, GradView } from "../components/Brand";
import { useApi } from "../lib/api";
import { speak } from "../lib/audio";
import { useHistory } from "../lib/history";
import { fonts, useColors } from "../lib/theme";

/** Past conversations, stored only on this phone. */
export function History({ owner, rate, onContinue }: { owner: string; rate: number; onContinue: (t: Thread) => void }) {
  const c = useColors();
  const s = useMemo(() => makeStyles(c), [c]);
  const api = useApi();
  const { threads, remove, clear, reload } = useHistory(owner);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => { reload(); }, []);
  const open = threads.find((t) => t.id === openId) ?? null;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? threads.filter((t) => t.title.toLowerCase().includes(q) || JSON.stringify(t.messages).toLowerCase().includes(q)) : threads;
  }, [threads, query]);

  if (open) {
    return (
      <ScrollView contentContainerStyle={s.page}>
        <View style={s.actionsRow}>
          <Btn kind="ghost" label="History" icon={<Icons.Back color={c.ink} />} onPress={() => setOpenId(null)} />
          {open.kind === "ask" && <Btn kind="primary" label="Continue chat" onPress={() => onContinue(open)} />}
          <Btn kind="ghost" label="Delete" icon={<Icons.Trash color={c.danger} />} onPress={() =>
            Alert.alert("Delete this conversation?", "", [{ text: "Cancel", style: "cancel" },
              { text: "Delete", style: "destructive", onPress: () => { remove(open.id); setOpenId(null); } }])} />
        </View>
        <Text style={s.h2}>{open.title || "Conversation"}</Text>
        <Text style={s.small}>{new Date(open.createdAt).toLocaleString()}</Text>
        <View style={{ gap: 10, marginTop: 14 }}>
          {open.kind === "ask" ? open.messages.map((m) => m.role === "user" ? (
            <GradView key={m.id} style={s.userBubble}><Text style={{ color: "#fff", fontSize: 16 }}>{m.text}</Text></GradView>
          ) : m.result ? (
            <View key={m.id} style={s.botBubble}>
              <Text style={s.lang}>{findLang(m.result.target).name.toUpperCase()}</Text>
              <Text style={s.tr}>{m.result.translation}</Text>
              {!!m.result.native_reading && <Text style={s.reading}>{m.result.native_reading}</Text>}
              {!!m.result.english_reading && <Text style={s.reading}>{m.result.english_reading}</Text>}
              <Pressable style={s.play} onPress={() => void speak(api, m.result!.translation, m.result!.target, rate, m.result!.voice_gender)}>
                <Icons.Speaker color={c.ink} size={18} /><Text style={{ color: c.ink, fontWeight: "600" }}>Play</Text>
              </Pressable>
            </View>
          ) : null) : open.messages.map((m) => (
            <Pressable key={m.id} onPress={() => void speak(api, m.translation, m.to, rate, m.gender)}
              style={[s.convBubble, { overflow: "hidden" }, m.who === "me" ? { alignSelf: "flex-end" } : { alignSelf: "flex-start" }]}>
              <GradFill name={m.who === "me" ? "you" : "them"} />
              <Text style={{ position: "relative", color: m.who === "me" ? "#fff" : c.themInk, opacity: 0.85, fontSize: 14 }}>{m.original}</Text>
              <Text style={{ position: "relative", color: m.who === "me" ? "#fff" : c.themInk, fontSize: 19, fontWeight: "700" }}>{m.translation}</Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    );
  }

  let lastDay = "";
  return (
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      <Text style={s.h1}>History</Text>
      <Text style={s.lead}>Your conversations are saved only on this phone. Nothing is kept on Bolverse's servers.</Text>
      {threads.length > 0 && (
        <TextInput style={s.search} value={query} onChangeText={setQuery} placeholder="Search your conversations" placeholderTextColor={c.muted} />
      )}
      {threads.length === 0 && (
        <View style={s.empty}><BotAvatar size={56} /><Text style={[s.lead, { textAlign: "center" }]}>Nothing here yet. Your Ask and Talk chats will appear here.</Text></View>
      )}
      {shown.map((t) => {
        const day = dayLabel(t.updatedAt);
        const header = day !== lastDay ? (lastDay = day) : null;
        return (
          <View key={t.id}>
            {header && <Text style={s.day}>{header}</Text>}
            <Pressable style={s.row} onPress={() => setOpenId(t.id)} accessibilityRole="button">
              <GradView name={t.kind === "ask" ? "you" : "them"} style={s.kind}>
                <View style={s.kindIcon}>{t.kind === "ask" ? <Icons.Sparkle color="#fff" size={20} /> : <Icons.Chat color={c.themInk} size={20} />}</View>
              </GradView>
              <View style={{ flex: 1 }}>
                <Text style={s.title} numberOfLines={1}>{t.title || "Conversation"}</Text>
                <Text style={s.small} numberOfLines={1}>{t.kind === "ask" ? "Ask" : "Talk"}: {findLang(t.source).name} to {findLang(t.target).name}</Text>
              </View>
            </Pressable>
          </View>
        );
      })}
      {threads.length > 0 && (
        <Btn kind="ghost" label="Clear all history" style={{ marginTop: 16 }} icon={<Icons.Trash color={c.danger} />} onPress={() =>
          Alert.alert("Delete all conversations on this phone?", "", [{ text: "Cancel", style: "cancel" }, { text: "Delete all", style: "destructive", onPress: clear }])} />
      )}
    </ScrollView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  page: { padding: 20, paddingBottom: 40 },
  h1: { fontFamily: fonts.display, fontSize: 30, color: c.ink, marginBottom: 4 },
  h2: { fontFamily: fonts.displayBold, fontSize: 22, color: c.ink, marginTop: 8 },
  lead: { color: c.muted, fontSize: 16, lineHeight: 23 },
  small: { color: c.muted, fontSize: 13 },
  search: { borderWidth: 1.5, borderColor: c.line, backgroundColor: c.surface, color: c.ink, borderRadius: 999, paddingVertical: 12, paddingHorizontal: 18, fontSize: 16, marginTop: 14 },
  empty: { alignItems: "center", gap: 12, paddingVertical: 40 },
  day: { color: c.muted, fontSize: 13, fontWeight: "700", marginTop: 18, marginBottom: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, borderRadius: 20, padding: 12, marginBottom: 8 },
  kind: { width: 40, height: 40, borderRadius: 14 },
  kindIcon: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { color: c.ink, fontWeight: "600", fontSize: 16 },
  actionsRow: { flexDirection: "row", gap: 8, flexWrap: "wrap", marginBottom: 12 },
  userBubble: { alignSelf: "flex-end", maxWidth: "86%", backgroundColor: c.you, borderRadius: 18, padding: 12 },
  botBubble: { alignSelf: "flex-start", maxWidth: "92%", backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, borderRadius: 18, padding: 14 },
  lang: { color: c.accent, fontSize: 12, fontWeight: "800" },
  tr: { color: c.ink, fontSize: 22, fontWeight: "600", marginVertical: 4 },
  reading: { color: c.ink, fontSize: 16, marginTop: 4 },
  play: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10, alignSelf: "flex-start", borderWidth: 1.5, borderColor: c.line, borderRadius: 11, paddingVertical: 6, paddingHorizontal: 12 },
  convBubble: { maxWidth: "86%", borderRadius: 18, padding: 12 },
});
