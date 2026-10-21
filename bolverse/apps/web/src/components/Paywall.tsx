import { useEffect, useRef, useState } from "react";
import { formatDay, PAYWALL_COPY, type PassPlan, type PayMethod, type PaywallReason } from "@bolverse/shared";
import { Sheet } from "./Sheet";
import { errorText, useApi } from "../lib/api";
import { useAccount } from "../lib/account";

const POLL_MS = 3000;
const GIVE_UP_MS = 10 * 60 * 1000;

export function Paywall({ reason, onClose }: { reason: PaywallReason; onClose: () => void }) {
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
    // Open the tab now, inside the click, so popup blockers allow it; point it at the payment page after.
    const tab = window.open("", "_blank");
    try {
      startedUntil.current = account.subscription?.valid_until ?? null;
      const co = await api.checkout(plan, method);
      setPayUrl(co.pay_url);
      if (tab) tab.location.href = co.pay_url;
      else window.open(co.pay_url, "_blank");
      setPhase("waiting");
    } catch (e) {
      tab?.close();
      setError(errorText(e));
    }
  }

  if (phase === "done" && account.subscription) {
    return (
      <Sheet title="You're on Premium" onClose={onClose}>
        <h2 className="sheet-title">You're on Premium</h2>
        <p className="muted">Valid until {formatDay(account.subscription.valid_until)}. Everything is unlocked.</p>
        <button className="btn big primary" onClick={onClose}>Continue</button>
      </Sheet>
    );
  }

  if (phase === "waiting") {
    return (
      <Sheet title="Waiting for payment" onClose={onClose}>
        <h2 className="sheet-title">Finish paying in the new tab</h2>
        {method === "upi" ? (
          <p className="muted" role="status">Pay with any UPI app, then enter the 12-digit UPI transaction ID on that page.
            Premium starts as soon as we confirm it, usually within a few hours; this updates by itself.</p>
        ) : (
          <p className="muted" role="status">{gaveUp
            ? "We haven't seen the payment yet. If you paid, it will appear within a few minutes; you can close this."
            : "This updates by itself as soon as the payment goes through."}</p>
        )}
        {payUrl && <p className="small"><a href={payUrl} target="_blank" rel="noreferrer">Open the payment page again</a></p>}
        <button className="btn ghost" onClick={onClose}>Close</button>
      </Sheet>
    );
  }

  return (
    <Sheet title={copy.title} onClose={onClose}>
      <h2 className="sheet-title">{copy.title}</h2>
      <p className="muted">{copy.body}</p>
      {reason === "translations" && account.usage.kind === "daily" && account.usage.resets_at && (
        <p className="small muted">Your free translations reset at {new Date(account.usage.resets_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.</p>
      )}
      {account.plan === "premium" && account.subscription && (
        <p className="notice">You're on Premium until {formatDay(account.subscription.valid_until)}. Buying again adds the time on after that.</p>
      )}
      <div className="plans" role="radiogroup" aria-label="Choose a pass">
        {account.prices.map((p) => (
          <button key={p.plan} type="button" role="radio" aria-checked={plan === p.plan}
            className={"plan" + (plan === p.plan ? " selected" : "")} onClick={() => setPlan(p.plan)}>
            <span className="plan-price">{p.label}</span>
            <span className="plan-name">{p.name}</span>
            {p.plan === "month" && <span className="plan-tag">Best value</span>}
          </button>
        ))}
      </div>
      {methods.length > 1 && (
        <div className="seg paymethod" role="radiogroup" aria-label="How to pay">
          {methods.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={method === m} aria-pressed={method === m} onClick={() => setMethod(m)}>
              {m === "upi" ? "UPI: PhonePe, GPay, Paytm" : "Card or other"}
            </button>
          ))}
        </div>
      )}
      <p className="small muted">One-time payment. No auto-renewal, so you're never charged again without choosing to.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {account.user ? (
        <button className="btn big primary" onClick={() => void pay()} disabled={!price}>Pay {price?.label ?? ""}</button>
      ) : (
        <>
          <button className="btn big primary" onClick={() => openLogin(reason)}>Log in to get Premium</button>
          <p className="small muted center">Premium belongs to your account, so it works on all your devices.</p>
        </>
      )}
    </Sheet>
  );
}
