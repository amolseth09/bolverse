import { useEffect, useMemo, useState } from "react";
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ApiError, DIAL_CODES, dialCodeFor, LANGUAGES, type Gender, type Palette, type VoiceGender } from "@bolverse/shared";
import { Btn, GradFill, Icons, LangPicker, Wordmark } from "../components/Brand";
import { errorText, useApi } from "../lib/api";
import { useAccount } from "../lib/account";
import { deviceLang, deviceRegion, SERVER_URL } from "../lib/store";
import { fonts, radius, useColors } from "../lib/theme";

type Step = "phone" | "code" | "details";

/** Quick check before sending; the server does the full check (letters in any script only). */
function nameProblem(name: string): string {
  const n = name.trim();
  if (!n) return "Enter your name.";
  if (n.length > 80) return "That name is too long.";
  if (/[0-9@#$%^&*()_+=[\]{};:"\\|,<>/?!~`]/.test(n)) return "Use letters only in your name.";
  return "";
}

export function AuthScreen({ onGuest, onClose }: { onGuest?: () => void; onClose?: () => void }) {
  const c = useColors();
  const s = useMemo(() => makeStyles(c), [c]);
  const api = useApi();
  const { signIn, offline } = useAccount();
  const [step, setStep] = useState<Step>("phone");
  const [dial, setDial] = useState(() => dialCodeFor(deviceRegion()));
  const [dialOpen, setDialOpen] = useState(false);
  const [number, setNumber] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string>();
  const [registered, setRegistered] = useState(false);
  const [signupToken, setSignupToken] = useState("");
  const [name, setName] = useState("");
  const [dd, setDd] = useState(""); const [mm, setMm] = useState(""); const [yyyy, setYyyy] = useState("");
  const [gender, setGender] = useState<Gender | "">("");
  const [voice, setVoice] = useState<VoiceGender | "">("");
  const [language, setLanguage] = useState(deviceLang);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resendIn, setResendIn] = useState(0);
  const [hello, setHello] = useState(0);

  const phone = `${dial}${number.replace(/\D/g, "")}`;
  const dob = `${yyyy.padStart(4, "0")}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((x) => x - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);
  useEffect(() => {
    if (step !== "phone") return;
    const t = setInterval(() => setHello((i) => (i + 1) % LANGUAGES.length), 2200);
    return () => clearInterval(t);
  }, [step]);

  function validDob(): boolean {
    const d = new Date(`${dob}T00:00:00Z`);
    return yyyy.length === 4 && !isNaN(d.getTime()) && d.getUTCDate() === Number(dd) && d.getUTCMonth() + 1 === Number(mm);
  }

  async function sendCode() {
    setBusy(true); setError("");
    try {
      const r = await api.requestOtp(phone);
      setRegistered(r.registered); setDevCode(r.dev_code); setResendIn(r.resend_in); setCode(""); setStep("code");
    } catch (e) { setError(errorText(e)); }
    setBusy(false);
  }

  async function verify(value = code) {
    if (value.length !== 6 || busy) return;
    setBusy(true); setError("");
    try {
      const r = await api.verify(phone, value);
      if (r.status === "signed_in") { signIn(r); return; }
      setSignupToken(r.signup_token); setStep("details");
    } catch (e) { setError(errorText(e)); }
    setBusy(false);
  }

  async function finish() {
    const bad = nameProblem(name);
    if (bad) { setError(bad); return; }
    if (!validDob()) { setError("Enter your date of birth as day, month and year."); return; }
    if (!gender) { setError("Choose your gender. Bolverse uses it for your voice and to word sentences correctly."); return; }
    if (gender === "other" && !voice) { setError("Choose the voice Bolverse should use for you."); return; }
    setBusy(true); setError("");
    try {
      const r = await api.complete({ signup_token: signupToken, name: name.trim(), dob, gender,
        voice_gender: gender === "other" ? (voice as VoiceGender) : undefined, language });
      signIn(r);
    } catch (e) {
      if (e instanceof ApiError && e.code === "signup_expired") setStep("phone");
      setError(errorText(e)); setBusy(false);
    }
  }

  const g = LANGUAGES[hello];
  const pill = (on: boolean) => [s.pill, on && { borderColor: "transparent", overflow: "hidden" as const }];
  const pillText = (on: boolean) => [s.pillText, on && { color: "#fff" }];

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
      <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Wordmark />
          {onClose && <Text style={s.link} onPress={onClose} accessibilityRole="button">Not now</Text>}
        </View>
        {step === "phone" && (
          <>
            <View style={s.hero}>
              <View style={s.helloPill}><Text style={s.hello}>{g.hello}</Text></View>
              <Text style={s.h1}>Talk with AI in <Text style={{ color: c.accent }}>any language</Text></Text>
              <Text style={s.lead}>Say it in your language. Bolverse translates it and speaks it out loud, in a voice that sounds like you.</Text>
              <View style={s.perks}>
                {([[Icons.Mic, "Just speak"], [Icons.Globe, "64 languages"], [Icons.Speaker, "Your voice"]] as const).map(([I, t]) => (
                  <View key={t} style={s.perk}><I color={c.accent} size={15} /><Text style={s.perkText}>{t}</Text></View>
                ))}
              </View>
            </View>
            <Text style={s.label}>Your mobile number</Text>
            <View style={s.row}>
              <Pressable style={[s.input, s.dial]} onPress={() => setDialOpen(true)} accessibilityRole="button" accessibilityLabel={`Country code ${dial}`}>
                <Text style={{ color: c.ink, fontSize: 16 }}>{dial} ▾</Text>
              </Pressable>
              <TextInput style={[s.input, { flex: 1, minWidth: 0 }]} value={number} onChangeText={setNumber} keyboardType="phone-pad" autoFocus
                textContentType="telephoneNumber" autoComplete="tel" placeholder="98765 43210" placeholderTextColor={c.muted} />
            </View>
            <Text style={s.hint}>We'll text you a 6-digit code. No password needed.</Text>
            {!!(error || offline) && <Text style={s.error}>{error || offline}</Text>}
            <Btn big kind="primary" style={s.full} disabled={busy || number.replace(/\D/g, "").length < 6}
              label={busy ? "Sending…" : onClose ? "Continue" : "Get started"} onPress={() => void sendCode()} />
            {onGuest && <Btn big kind="ghost" style={[s.full, { marginTop: 10 }]} label="Try it first, without an account" onPress={onGuest} />}
          </>
        )}

        {step === "code" && (
          <>
            <Text style={[s.h1, { marginTop: 28 }]}>Enter your code</Text>
            <Text style={s.lead}>Sent to {dial} {number}. <Text style={s.link} onPress={() => setStep("phone")}>Change</Text></Text>
            {devCode && <Text style={s.notice}>Test mode: your code is {devCode}</Text>}
            <TextInput style={s.otp} value={code} keyboardType="number-pad" maxLength={6} autoFocus
              textContentType="oneTimeCode" autoComplete="sms-otp" accessibilityLabel="6-digit code"
              onChangeText={(t) => { const v = t.replace(/\D/g, "").slice(0, 6); setCode(v); if (v.length === 6) void verify(v); }} />
            {!!error && <Text style={s.error}>{error}</Text>}
            <Btn big kind="primary" style={s.full} disabled={busy || code.length !== 6}
              label={busy ? "Checking…" : registered ? "Log in" : "Verify"} onPress={() => void verify()} />
            <Text style={s.center}>
              {resendIn > 0 ? `You can ask for a new code in ${resendIn}s.` : <Text style={s.link} onPress={() => void sendCode()}>Send a new code</Text>}
            </Text>
          </>
        )}

        {step === "details" && (
          <>
            <Text style={[s.h1, { marginTop: 28 }]}>Nice to meet you</Text>
            <Text style={s.lead}>A few details so Bolverse can speak for you properly.</Text>
            <Text style={s.label}>Your name</Text>
            <TextInput style={s.input} value={name} onChangeText={setName} autoComplete="name" textContentType="name" autoFocus />
            <Text style={s.label}>Date of birth</Text>
            <View style={s.row}>
              <TextInput style={[s.input, { flex: 1, minWidth: 0 }]} value={dd} onChangeText={(t) => setDd(t.replace(/\D/g, "").slice(0, 2))}
                placeholder="DD" placeholderTextColor={c.muted} keyboardType="number-pad" maxLength={2} accessibilityLabel="Day of birth" />
              <TextInput style={[s.input, { flex: 1, minWidth: 0 }]} value={mm} onChangeText={(t) => setMm(t.replace(/\D/g, "").slice(0, 2))}
                placeholder="MM" placeholderTextColor={c.muted} keyboardType="number-pad" maxLength={2} accessibilityLabel="Month of birth" />
              <TextInput style={[s.input, { flex: 1.6 }]} value={yyyy} onChangeText={(t) => setYyyy(t.replace(/\D/g, "").slice(0, 4))}
                placeholder="YYYY" placeholderTextColor={c.muted} keyboardType="number-pad" maxLength={4} accessibilityLabel="Year of birth" />
            </View>
            <Text style={s.label}>Gender</Text>
            <View style={s.pills} accessibilityRole="radiogroup">
              {(["female", "male", "other"] as Gender[]).map((x) => (
                <Pressable key={x} style={pill(gender === x)} onPress={() => setGender(x)} accessibilityRole="radio" accessibilityState={{ checked: gender === x }}>
                  {gender === x && <GradFill />}
                  <View><Text style={pillText(gender === x)}>{x === "female" ? "Female" : x === "male" ? "Male" : "Other"}</Text></View>
                </Pressable>
              ))}
            </View>
            <Text style={s.hint}>Bolverse speaks for you in this voice, and words sentences for you correctly: in Hindi "मैं थका हूँ" or "मैं थकी हूँ".</Text>
            {gender === "other" && (
              <>
                <Text style={s.label}>Which voice should speak for you?</Text>
                <View style={s.pills}>
                  {(["female", "male"] as VoiceGender[]).map((v) => (
                    <Pressable key={v} style={pill(voice === v)} onPress={() => setVoice(v)} accessibilityRole="radio" accessibilityState={{ checked: voice === v }}>
                      {voice === v && <GradFill />}
                      <View><Text style={pillText(voice === v)}>{v === "female" ? "Female voice" : "Male voice"}</Text></View>
                    </Pressable>
                  ))}
                </View>
              </>
            )}
            <Text style={s.label}>Your language</Text>
            <LangPicker value={language} onChange={setLanguage} label="Your language" />
            {!!error && <Text style={s.error}>{error}</Text>}
            <Btn big kind="primary" style={s.full} disabled={busy} label={busy ? "Setting up…" : "Start talking"} onPress={() => void finish()} />
          </>
        )}

        {!!offline && __DEV__ && (
          <Text style={[s.center, { marginTop: 22 }]}>Developer note: the app is looking for the server at {SERVER_URL}. Set EXPO_PUBLIC_API_URL in apps/mobile/.env and restart Expo.</Text>
        )}
      </ScrollView>

      <Modal visible={dialOpen} transparent animationType="fade" onRequestClose={() => setDialOpen(false)}>
        <Pressable style={s.scrim} onPress={() => setDialOpen(false)}>
          <View style={s.dialList}>
            <FlatList data={DIAL_CODES} keyExtractor={(d) => d.region} renderItem={({ item }) => (
              <Pressable style={s.dialRow} onPress={() => { setDial(item.code); setDialOpen(false); }}>
                <Text style={{ color: c.ink, fontSize: 16 }}>{item.name}</Text>
                <Text style={{ color: c.muted, fontSize: 16 }}>{item.code}</Text>
              </Pressable>
            )} />
          </View>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  wrap: { padding: 22, paddingBottom: 40 },
  hero: { marginTop: 26, marginBottom: 14 },
  helloPill: { alignSelf: "flex-start", backgroundColor: c.youSoft, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 14, marginBottom: 10 },
  hello: { fontFamily: fonts.display, fontSize: 22, lineHeight: 28, color: c.accent },
  h1: { fontFamily: fonts.display, fontSize: 34, lineHeight: 38, color: c.ink, letterSpacing: -0.8, marginBottom: 8 },
  perks: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 14 },
  perk: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 12 },
  perkText: { color: c.ink, fontWeight: "700", fontSize: 13 },
  lead: { color: c.muted, fontSize: 17, lineHeight: 25 },
  label: { color: c.ink, fontWeight: "700", fontSize: 16, marginTop: 16, marginBottom: 6 },
  hint: { color: c.muted, fontSize: 14, marginTop: 6, lineHeight: 20 },
  input: { borderWidth: 1.5, borderColor: c.line, backgroundColor: c.surface, color: c.ink, borderRadius: 16, paddingVertical: 13, paddingHorizontal: 15, fontSize: 16 },
  row: { flexDirection: "row", gap: 8 },
  dial: { justifyContent: "center", minWidth: 88 },
  otp: { borderWidth: 1.5, borderColor: c.line, backgroundColor: c.surface, color: c.ink, borderRadius: radius.control, fontSize: 30, letterSpacing: 12, textAlign: "center", paddingVertical: 14, marginVertical: 14 },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pill: { borderWidth: 1.5, borderColor: c.line, backgroundColor: c.surface, borderRadius: 999, paddingVertical: 10, paddingHorizontal: 18 },
  pillText: { color: c.ink, fontWeight: "600" },
  error: { color: c.danger, marginTop: 12, fontSize: 15 },
  link: { color: c.accent, fontWeight: "600", textDecorationLine: "underline" },
  notice: { backgroundColor: c.highlight, color: c.ink, borderRadius: 14, padding: 10, marginTop: 12, overflow: "hidden" },
  full: { alignSelf: "stretch", marginTop: 20 },
  center: { color: c.muted, textAlign: "center", marginTop: 14, fontSize: 14 },
  scrim: { flex: 1, backgroundColor: "rgba(11,9,32,0.5)", justifyContent: "center", padding: 24 },
  dialList: { backgroundColor: c.surface, borderRadius: 20, maxHeight: "70%", paddingVertical: 8 },
  dialRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 12, paddingHorizontal: 18 },
});
