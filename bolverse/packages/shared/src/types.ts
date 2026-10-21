/* ---------- Settings kept on this device ---------- */

export interface Profile {
  rate: number;          // speaking speed, 0.6 to 1.3
  speakTheirs: boolean;  // read the other person's words aloud in my language
  myLang: string;        // used only when the server runs without accounts (otherwise it comes from the account)
  askTarget: string;     // last language chosen in Ask
  target: string;        // the other person's language in Converse
}

/* ---------- Account (from the server) ---------- */

export type Gender = "male" | "female" | "other";
export type VoiceGender = "male" | "female";
export type PlanLevel = "open" | "guest" | "free" | "premium";
export type PassPlan = "day" | "week" | "month";
export type PayMethod = "upi" | "card";

export interface Price { plan: PassPlan; days: number; name: string; currency: "INR" | "USD"; amount: number; amount_minor: number; label: string }

export interface AccountUser {
  id: string; name: string; phone: string; dob: string; gender: Gender | "";
  voice_gender: VoiceGender; language: string; country: string; member_since: string;
}

export interface Account {
  user: AccountUser | null;
  plan: PlanLevel;
  subscription: null | { plan: PassPlan; valid_until: string; days_left: number };
  /** kind "total": `today` = free translations used so far, `daily_limit` = free in total (guests and
   *  free users). kind "daily": per-day allowance. kind "unlimited": Premium. */
  usage: { today: number; daily_limit: number | null; resets_at: string | null; kind?: "total" | "daily" | "unlimited"; left?: number | null };
  prices: Price[];
  /** How this user can pay: "upi" (direct to the business UPI ID, India) and/or "card". */
  payment_methods?: PayMethod[];
  features?: { learning: boolean };
}

export interface OtpSent { sent: boolean; registered: boolean; expires_in: number; resend_in: number; dev_code?: string }
/** Short-lived access token (15 min) and a refresh token that changes every time it's used. */
export interface Tokens { access: string; refresh: string }
export interface SignedIn {
  status: "signed_in"; access_token: string; refresh_token: string; expires_in: number;
  /** Same as access_token; kept for older apps. */
  token: string;
  account: Account;
}
export type VerifyResult = SignedIn | { status: "new_user"; signup_token: string };
export interface NewUserDetails {
  signup_token: string; name: string; dob: string; gender: Gender; voice_gender?: VoiceGender; language: string;
}
export interface Checkout {
  payment_id: string; pay_url: string; plan: PassPlan; method: PayMethod; currency: string; amount: number; label: string; reference: string;
}

/* ---------- Translation ---------- */

export interface AskResult {
  question: string; source_text: string; translation: string;
  native_reading: string; english_reading: string; target: string; voice_gender: VoiceGender | null;
}
export interface TranslateResult { translation: string; romanized: string; source_text?: string }
export interface ConverseResult extends TranslateResult { original: string; speaker_gender: VoiceGender | null }

export interface Health {
  status: string; accounts: boolean; device: string;
  ai: { mode: "local" | "remote"; reachable?: boolean; device?: string; loaded?: Record<string, boolean> };
}

/** Why the paywall opened. */
export type PaywallReason = "translations" | "upgrade";

/* ---------- Chat history (stored only on the device) ---------- */

export interface AskMessage {
  id: string; role: "user" | "bot"; at: number;
  text?: string;                 // user's words
  result?: AskResult;            // bot's answer
  error?: string;
}

export interface ConverseMessage {
  id: string; who: "me" | "them"; at: number;
  original: string; translation: string; romanized: string; to: string; gender: VoiceGender | null;
}

export type Thread =
  | { id: string; kind: "ask"; title: string; source: string; target: string; createdAt: number; updatedAt: number; messages: AskMessage[] }
  | { id: string; kind: "converse"; title: string; source: string; target: string; createdAt: number; updatedAt: number; messages: ConverseMessage[] };

/* ---------- Connect: chatting with another phone ---------- */

export interface Person { id: string; name: string; language: string; gender: VoiceGender }
export interface Invite { qr: string; token: string; code: string; expires_at: string; expires_in: number }
export interface ConnectionInfo { id: string; peer: Person; since: string; waiting?: number }

/** A message from the server, or one this phone sent. */
/** Where one of my messages is: on this phone only, saved by the server, or on the other person's phone. */
export type DeliveryStatus = "sending" | "sent" | "delivered" | "failed";

export interface ChatMessage {
  /** Server id once saved there; "local-..." while it's still only on this device. */
  id: number | string;
  /** Made up by the sending app; the server uses it to ignore retries of the same message. */
  client_id?: string | null;
  connection_id: string;
  kind: "text" | "voice" | "joined" | "ended";
  from_me: boolean;
  /** Only for my own messages. */
  status?: DeliveryStatus | null;
  /** Why sending failed (shown with a Retry button). */
  error?: string;
  /** For a voice message that failed: the recording, so Retry can resend it (phones keep the file). */
  audio_uri?: string;
  original: string;
  source: string;
  translation: string;
  target: string;
  gender: VoiceGender | null;
  at: string;
  peer?: Person | null;
}

/** A chat as kept on this device. */
export interface Chat {
  id: string;            // connection id
  peer: Person;
  since: string;
  ended: boolean;        // disconnected by either side
  unread: number;
  messages: ChatMessage[];
  updatedAt: number;
}
