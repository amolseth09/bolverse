import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { formatDay, PAYWALL_COPY, type Palette, type PassPlan, type PayMethod, type PaywallReason } from "@bolverse/shared";
import { Btn } from "./Brand";
import { Sheet } from "./Sheet";
import { errorText, useApi } from "../lib/api";
import { useAccount } from "../lib/account";
import { fonts, useColors } from "../lib/theme";

const POLL_MS = 3000;
const GIVE_UP_MS = 10 * 60 * 1000;

export function Paywall({ reason, onClose }: { reason: PaywallReason; onClose: () => void }) {
  const c = useColors();
  const s = useMemo(() => makeStyles(c), [c]);
  const api = useApi();
  const { account, refresh, openLogin } = useAccount();
  const [plan, setPlan] = useState<PassPlan>("month");
  const methods = account.payment_methods ?? ["card"];
  const [method, setMethod] = useState<PayMethod>(methods[0] ?? "card");
  const [phase, setPhase] = useState<"choose" | "waiting" | "done">("choose");
  const [error, setError] = useState("");
  const [payUrl, setPayUrl] = useState("");
  const [gaveUp, setGaveUp] = useState(false);
  const startedUntil = useRef<string | null>(null);
  const copy = PAYWALL_COPY[reason];
  const price = account.prices.find((p) => p.plan === plan);

  useEffect(() => {
    if (phase !== "waiting") return;
    const started = Date.now();
    const t = setInterval(async () => {
      const a = await refresh();
      if (a?.subscription && a.subscription.valid_until !== startedUntil.current) { setPhase("done"); clearInterval(t); }
      else if (Date.now() - started > GIVE_UP_MS) { setGaveUp(true); clearInterval(t); }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [phase]);

  async function pay() {
    setError("");
    try {
      startedUntil.current = account.subscription?.valid_until ?? null;
      const co = await api.checkout(plan, method);
      setPayUrl(co.pay_url);
      setPhase("waiting");
      await WebBrowser.openBrowserAsync(co.pay_url);
      void refresh();
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (phase === "done" && account.subscription) {
    return (
      <Sheet title="You're on Premium" onClose={onClose}>
        <Text style={s.muted}>Valid until {formatDay(account.subscription.valid_until)}. Everything is unlocked.</Text>
        <Btn big kind="primary" label="Continue" style={s.full} onPress={onClose} />
      </Sheet>
    );
  }

  if (phase === "waiting") {
    return (
      <Sheet title="Finishing your payment" onClose={onClose}>
        <Text style={s.muted} accessibilityLiveRegion="polite">{method === "upi"
          ? "Pay with any UPI app, then enter the 12-digit UPI transaction ID on the payment page. Premium starts as soon as we confirm it, usually within a few hours; this updates by itself."
          : gaveUp
            ? "We haven't seen the payment yet. If you paid, it will appear within a few minutes; you can close this."
            : "This updates by itself as soon as the payment goes through."}</Text>
        {!!payUrl && <Btn kind="ghost" label="Open the payment page again" onPress={() => void WebBrowser.openBrowserAsync(payUrl)} />}
        <Btn kind="ghost" label="Close" style={{ marginTop: 10 }} onPress={onClose} />
      </Sheet>
    );
  }

  return (
    <Sheet title={copy.title} onClose={onClose}>
      <Text style={s.muted}>{copy.body}</Text>
      {reason === "translations" && account.usage.kind === "daily" && !!account.usage.resets_at && (
        <Text style={s.small}>Your free translations reset at {new Date(account.usage.resets_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.</Text>
      )}
      {account.plan === "premium" && account.subscription && (
        <Text style={s.notice}>You're on Premium until {formatDay(account.subscription.valid_until)}. Buying again adds the time on after that.</Text>
      )}
      <View style={s.plans} accessibilityRole="radiogroup">
        {account.prices.map((p) => {
          const selected = plan === p.plan;
          return (
            <Pressable key={p.plan} onPress={() => setPlan(p.plan)} accessibilityRole="radio" accessibilityState={{ checked: selected }}
              style={[s.plan, selected && { borderColor: c.you, backgroundColor: c.youSoft }]}>
              {p.plan === "month" && <Text style={s.tag}>Best value</Text>}
              <Text style={s.price}>{p.label}</Text>
              <Text style={s.planName}>{p.name}</Text>
            </Pressable>
          );
        })}
      </View>
      {methods.length > 1 && (
        <View style={s.methods} accessibilityRole="radiogroup">
          {methods.map((m) => (
            <Pressable key={m} onPress={() => setMethod(m)} accessibilityRole="radio" accessibilityState={{ checked: method === m }}
              style={[s.method, method === m && { backgroundColor: c.you }]}>
              <Text style={[s.methodText, method === m && { color: "#fff" }]}>{m === "upi" ? "UPI app" : "Card / other"}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <Text style={s.small}>{method === "upi" ? "Pay with PhonePe, Google Pay, Paytm, Amazon Pay or any UPI app. " : ""}One-time payment. No auto-renewal.</Text>
      {!!error && <Text style={s.error}>{error}</Text>}
      {account.user ? (
        <Btn big kind="primary" style={s.full} disabled={!price} label={`Pay ${price?.label ?? ""}`} onPress={() => void pay()} />
      ) : (
        <>
          <Btn big kind="primary" style={s.full} label="Log in to get Premium" onPress={() => openLogin(reason)} />
          <Text style={[s.small, { textAlign: "center", marginTop: 8 }]}>Premium belongs to your account, so it works on all your devices.</Text>
        </>
      )}
    </Sheet>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  muted: { color: c.muted, fontSize: 16, lineHeight: 23, marginBottom: 8 },
  small: { color: c.muted, fontSize: 13, lineHeight: 18 },
  notice: { backgroundColor: c.highlight, color: c.ink, borderRadius: 14, padding: 10, marginVertical: 8, overflow: "hidden" },
  plans: { flexDirection: "row", gap: 8, marginTop: 18, marginBottom: 12 },
  plan: { flex: 1, borderWidth: 2, borderColor: c.line, backgroundColor: c.bg, borderRadius: 18, paddingVertical: 14, paddingHorizontal: 10 },
  price: { fontFamily: fonts.display, fontSize: 24, color: c.ink, letterSpacing: -0.6 },
  methods: { flexDirection: "row", borderWidth: 1.5, borderColor: c.line, borderRadius: 12, overflow: "hidden", marginBottom: 10 },
  method: { flex: 1, paddingVertical: 10, alignItems: "center" },
  methodText: { color: c.muted, fontWeight: "600", fontSize: 14 },
  planName: { color: c.muted, fontSize: 15 },
  tag: { position: "absolute", top: -11, right: 6, backgroundColor: c.gradC, color: "#fff", fontSize: 11, fontWeight: "800", borderRadius: 999, paddingHorizontal: 9, paddingVertical: 2, overflow: "hidden" },
  error: { color: c.danger, marginTop: 10 },
  full: { alignSelf: "stretch", marginTop: 16 },
  center: { color: c.muted, textAlign: "center", marginTop: 14, fontSize: 14 },
  link: { color: c.accent, fontWeight: "600", textDecorationLine: "underline" },
});
