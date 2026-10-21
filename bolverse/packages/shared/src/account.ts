import type { Account, PaywallReason, Thread } from "./types";

/** Calling codes for the phone field. The server validates every number properly. */
export const DIAL_CODES: { region: string; code: string; name: string }[] = [
  { region: "IN", code: "+91", name: "India" }, { region: "US", code: "+1", name: "United States / Canada" },
  { region: "GB", code: "+44", name: "United Kingdom" }, { region: "AE", code: "+971", name: "United Arab Emirates" },
  { region: "SA", code: "+966", name: "Saudi Arabia" }, { region: "SG", code: "+65", name: "Singapore" },
  { region: "AU", code: "+61", name: "Australia" }, { region: "DE", code: "+49", name: "Germany" },
  { region: "FR", code: "+33", name: "France" }, { region: "ES", code: "+34", name: "Spain" },
  { region: "IT", code: "+39", name: "Italy" }, { region: "NL", code: "+31", name: "Netherlands" },
  { region: "BR", code: "+55", name: "Brazil" }, { region: "JP", code: "+81", name: "Japan" },
  { region: "KR", code: "+82", name: "South Korea" }, { region: "CN", code: "+86", name: "China" },
  { region: "ID", code: "+62", name: "Indonesia" }, { region: "TH", code: "+66", name: "Thailand" },
  { region: "VN", code: "+84", name: "Vietnam" }, { region: "MY", code: "+60", name: "Malaysia" },
  { region: "PH", code: "+63", name: "Philippines" }, { region: "TR", code: "+90", name: "Turkey" },
  { region: "RU", code: "+7", name: "Russia" }, { region: "PL", code: "+48", name: "Poland" },
  { region: "KE", code: "+254", name: "Kenya" }, { region: "ZA", code: "+27", name: "South Africa" },
  { region: "BD", code: "+880", name: "Bangladesh" }, { region: "LK", code: "+94", name: "Sri Lanka" },
  { region: "NP", code: "+977", name: "Nepal" }, { region: "PK", code: "+92", name: "Pakistan" },
];

/** "hi-IN" or "IN" -> "IN" */
export function regionOf(locale: string): string {
  const parts = locale.replace("_", "-").split("-");
  const r = parts.find((p, i) => i > 0 && /^[A-Za-z]{2}$/.test(p));
  return (r ?? "").toUpperCase();
}

export function dialCodeFor(region: string): string {
  return DIAL_CODES.find((d) => d.region === region.toUpperCase())?.code ?? "+91";
}

/** Random ID for this install. */
export function newDeviceId(): string {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 32; i++) out += hex[Math.floor(Math.random() * 16)];
  return out;
}

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Used until the server answers. */
export const LOADING_ACCOUNT: Account = {
  user: null, plan: "guest", subscription: null,
  usage: { today: 0, daily_limit: null, resets_at: "" }, prices: [],
};

export function accountsEnabled(account: Account): boolean {
  return account.plan !== "open";
}

export function isSignedIn(account: Account): boolean {
  return account.plan === "open" || account.user !== null;
}

/** Free translations left (today, or in total for guests and free users); null = unlimited. */
export function leftToday(account: Account): number | null {
  const { today, daily_limit, left } = account.usage;
  if (left !== undefined) return left;
  return daily_limit === null ? null : Math.max(0, daily_limit - today);
}

/** "12 of 50 free left" style text for the free allowance. */
export function freeLeftText(account: Account): string | null {
  const left = leftToday(account);
  if (left === null) return null;
  const total = account.usage.daily_limit ?? 0;
  return account.usage.kind === "daily" ? `${left} of ${total} free today` : `${left} of ${total} free left`;
}

export function isGuest(account: Account): boolean {
  return account.plan === "guest";
}

export function planLabel(account: Account): string {
  if (account.plan === "open") return "Open access";
  if (account.plan === "premium") return account.subscription?.plan === "week" ? "Premium, weekly" : "Premium, monthly";
  return "Free";
}

export function formatDay(iso: string, locale?: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
}

export function formatTime(iso: string, locale?: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

export function firstName(account: Account): string {
  return account.user?.name.split(" ")[0] ?? "";
}

export const PAYWALL_COPY: Record<PaywallReason, { title: string; body: string }> = {
  translations: {
    title: "You've used your free translations",
    body: "Get Premium for unlimited translations in every language, with voices that match you.",
  },
  upgrade: {
    title: "Bolverse Premium",
    body: "Unlimited translations every day, in every language, with voices that match you.",
  },
};

export function paywallReasonFor(code: string | undefined): PaywallReason | null {
  return code === "quota_exceeded" ? "translations" : null;
}

/* ---------- Chat history helpers (storage lives in each app) ---------- */

export const MAX_THREADS = 200;

export function upsertThread(list: Thread[], thread: Thread): Thread[] {
  const rest = list.filter((t) => t.id !== thread.id);
  return [thread, ...rest].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_THREADS);
}

export function dayLabel(ts: number, locale?: string): string {
  const d = new Date(ts), now = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(locale, { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

/** Handy phrases for the Ask screen, asked in English and answered in the chosen language. */
export const SUGGESTIONS = [
  "Where is the nearest railway station?",
  "How much does this cost?",
  "I need a doctor, please help me.",
  "Can you take me to this address?",
  "I don't eat meat or eggs.",
  "Thank you very much for your help!",
];

/**
 * Which voice to use for speech: the server's (better quality) or the device's own.
 * The server lists the genders it can speak; older servers say ["any"] for a single voice that ignores
 * the requested gender. When a gender was chosen and the server can't do it, the device voice is used
 * (it picks a voice of that gender, or shifts the pitch).
 */
export function voiceSource(serverGenders: string[], gender?: "male" | "female" | null): "server" | "device" {
  if (!serverGenders.length) return "device";
  if (!gender) return "server";
  return serverGenders.includes(gender) ? "server" : "device";
}
