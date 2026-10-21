import { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { accountsEnabled, findLang, formatDay, freeLeftText, isGuest, leftToday, planLabel, type Palette, type Profile, type VoiceGender } from "@bolverse/shared";
import { Btn, GradFill, GradView, Icons, LangPicker, Logo, shadow } from "../components/Brand";
import { errorText, useApi } from "../lib/api";
import { useAccount } from "../lib/account";
import { speak } from "../lib/audio";
import { useHistory } from "../lib/history";
import { fonts, useColors } from "../lib/theme";

export function ProfileScreen({ prefs, updatePrefs, owner }: {
  prefs: Profile; updatePrefs: (p: Partial<Profile>) => void; owner: string;
}) {
  const c = useColors();
  const s = useMemo(() => makeStyles(c), [c]);
  const api = useApi();
  const { account, refresh, openPaywall, signOut, openLogin } = useAccount();
  const { threads, clear } = useHistory(owner);
  const [saving, setSaving] = useState("");
  const user = account.user;
  const me = findLang(user?.language ?? prefs.myLang);
  const premium = account.plan === "premium";
  const left = leftToday(account);
  const fg = premium ? "#fff" : c.ink;

  async function change(patch: { language?: string; voice_gender?: VoiceGender }) {
    if (!user) { if (patch.language) updatePrefs({ myLang: patch.language }); return; }
    setSaving("Saving…");
    try { await api.updateMe(patch); await refresh(); setSaving("Saved"); } catch (e) { setSaving(errorText(e)); }
    setTimeout(() => setSaving(""), 1500);
  }
  const setRate = (r: number) => updatePrefs({ rate: Math.round(Math.min(1.3, Math.max(0.6, r)) * 10) / 10 });

  return (
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      {isGuest(account) && (
        <View style={s.card}>
          <Text style={[s.name, { color: c.ink }]}>You're a guest</Text>
          <Text style={[s.badge, { marginBottom: 10 }]}>{freeLeftText(account) ?? "Free"}</Text>
          <Text style={s.lead}>Log in with your mobile number to keep your voice settings, use Connect, and get Premium.</Text>
          <Btn kind="primary" label="Log in or sign up" style={{ marginTop: 14, alignSelf: "stretch" }} onPress={() => openLogin()} />
        </View>
      )}
      {user && (
        <View style={[s.card, premium && { borderColor: "transparent", overflow: "hidden" }, premium && shadow(c.you)]}>
          {premium && <GradFill name="aurora" />}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <GradView style={[s.letter, premium && { opacity: 0.9 }]}><Text style={s.letterText}>{user.name.slice(0, 1).toUpperCase()}</Text></GradView>
            <View style={{ flex: 1 }}>
              <Text style={[s.name, { color: fg }]}>{user.name}</Text>
              <Text style={[s.badge, premium && { backgroundColor: "#fff", color: c.accent }]}>{planLabel(account)}</Text>
            </View>
          </View>
          {premium && account.subscription ? (
            <Text style={{ color: fg, fontSize: 16, marginTop: 12 }}>
              Valid until <Text style={{ fontWeight: "700" }}>{formatDay(account.subscription.valid_until)}</Text> ({account.subscription.days_left} days left). Unlimited translations.
            </Text>
          ) : (
            <View style={s.usage}>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ color: c.ink }}>{account.usage.kind === "daily" ? "Today's free translations" : "Free translations used"}</Text>
                <Text style={{ color: c.ink, fontWeight: "700" }}>{account.usage.today} of {account.usage.daily_limit}</Text>
              </View>
              <View style={s.meter}><View style={[s.meterFill, { width: `${Math.min(100, (account.usage.today / (account.usage.daily_limit || 1)) * 100)}%` }]}><GradFill name="aurora" /></View></View>
              <Text style={s.small}>{left} left.{account.usage.kind === "daily" ? " Resets at midnight." : " Then Premium keeps you going."}</Text>
            </View>
          )}
          <View style={{ marginTop: 12, gap: 5 }}>
            {([["Mobile", user.phone], ["Date of birth", formatDay(user.dob)],
               ["Gender", user.gender ? user.gender[0].toUpperCase() + user.gender.slice(1) : "Not set"],
               ["Member since", formatDay(user.member_since)]] as const).map(([k, v]) => (
              <View key={k} style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ color: premium ? "#fff" : c.muted, opacity: premium ? 0.85 : 1 }}>{k}</Text>
                <Text style={{ color: fg, fontWeight: "600" }}>{v}</Text>
              </View>
            ))}
          </View>
          <Btn kind={premium ? "onPrimary" : "primary"} label={premium ? "Extend Premium" : "Get Premium"} style={{ marginTop: 16, alignSelf: "stretch" }} onPress={() => openPaywall("upgrade")} />
        </View>
      )}

      <Text style={s.h2}>Your voice and language</Text>
      <Text style={s.label}>I speak</Text>
      <LangPicker value={me.code} label="Your language" onChange={(code) => void change({ language: code })} />
      {user && (
        <>
          <Text style={s.label}>Bolverse speaks for me in a</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {(["female", "male"] as VoiceGender[]).map((v) => (
              <Pressable key={v} onPress={() => void change({ voice_gender: v })} accessibilityRole="radio" accessibilityState={{ checked: user.voice_gender === v }}
                style={[s.pill, user.voice_gender === v && { borderColor: "transparent", overflow: "hidden" }]}>
                {user.voice_gender === v && <GradFill />}
                <Text style={{ position: "relative", color: user.voice_gender === v ? "#fff" : c.ink, fontWeight: "700" }}>{v === "female" ? "Female voice" : "Male voice"}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={s.small}>Also used to word sentences about you correctly.</Text>
        </>
      )}
      {!!saving && <Text style={s.small}>{saving}</Text>}

      <Text style={s.label}>Speaking speed</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pressable style={s.step} accessibilityLabel="Slower" onPress={() => setRate(prefs.rate - 0.1)}><Text style={s.stepText}>−</Text></Pressable>
        <Text style={{ color: c.ink, minWidth: 48, textAlign: "center", fontSize: 16 }}>{prefs.rate.toFixed(1)}x</Text>
        <Pressable style={s.step} accessibilityLabel="Faster" onPress={() => setRate(prefs.rate + 0.1)}><Text style={s.stepText}>+</Text></Pressable>
        <Btn kind="ghost" label="Test voice" icon={<Icons.Speaker color={c.ink} />} onPress={() => void speak(api, me.hello, me.code, prefs.rate, user?.voice_gender)} />
      </View>
      <View style={s.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: c.ink, fontSize: 16 }}>In Converse, read their words aloud to me</Text>
          <Text style={s.small}>Turn off if you'd rather just read them.</Text>
        </View>
        <Switch value={prefs.speakTheirs} onValueChange={(v) => updatePrefs({ speakTheirs: v })} trackColor={{ true: c.you, false: c.line }} />
      </View>

      <Text style={s.h2}>Your data</Text>
      <Text style={s.lead}>Your {threads.length} saved {threads.length === 1 ? "conversation stays" : "conversations stay"} only on this phone. Bolverse's server keeps your account and your free-translation count, never what you said.</Text>
      <Btn kind="ghost" label="Clear history" disabled={!threads.length} style={{ marginTop: 10 }} icon={<Icons.Trash color={c.danger} />} onPress={() =>
        Alert.alert("Delete all conversations on this phone?", "", [{ text: "Cancel", style: "cancel" }, { text: "Delete all", style: "destructive", onPress: clear }])} />


      {accountsEnabled(account) && user && (
        <Btn kind="ghost" label="Log out" style={{ alignSelf: "stretch", marginTop: 24 }} onPress={() => void signOut()} />
      )}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 24 }}>
        <Logo size={26} /><Text style={s.small}>Bolverse · Talk with AI in any language</Text>
      </View>
    </ScrollView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  page: { padding: 20, paddingBottom: 40 },
  card: { borderWidth: 1, borderColor: c.line, backgroundColor: c.surface, borderRadius: 26, padding: 18 },
  usage: { marginTop: 14, backgroundColor: c.bg, borderRadius: 16, padding: 12 },
  letter: { width: 54, height: 54, borderRadius: 27, alignItems: "center", justifyContent: "center" },
  letterText: { fontFamily: fonts.display, fontSize: 24, color: "#fff", textAlign: "center" },
  name: { fontFamily: fonts.display, fontSize: 24 },
  badge: { alignSelf: "flex-start", backgroundColor: c.themSoft, color: c.ink, fontWeight: "800", fontSize: 12, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 2, overflow: "hidden", marginTop: 4 },
  meter: { height: 10, borderRadius: 10, backgroundColor: c.youSoft, overflow: "hidden", marginVertical: 8 },
  meterFill: { height: 10, borderRadius: 10, overflow: "hidden" },
  h2: { fontFamily: fonts.displayBold, fontSize: 20, color: c.ink, marginTop: 26, marginBottom: 4 },
  label: { color: c.ink, fontWeight: "600", fontSize: 16, marginTop: 14, marginBottom: 6 },
  lead: { color: c.muted, fontSize: 15, lineHeight: 22 },
  small: { color: c.muted, fontSize: 13, marginTop: 4 },
  pill: { borderWidth: 1.5, borderColor: c.line, backgroundColor: c.surface, borderRadius: 999, paddingVertical: 10, paddingHorizontal: 16 },
  step: { width: 44, height: 44, borderRadius: 12, borderWidth: 1.5, borderColor: c.line, alignItems: "center", justifyContent: "center" },
  stepText: { color: c.ink, fontSize: 22, fontWeight: "600" },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 18 },
  advanced: { marginTop: 26, borderWidth: 1, borderColor: c.line, borderRadius: 18, padding: 14, backgroundColor: c.surface },
});
