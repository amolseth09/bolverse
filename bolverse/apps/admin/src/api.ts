/** Talks to the Bolverse server's /admin API. Same origin by default (served at /dashboard). */
const BASE = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");
const KEY = "bolverse-admin-token";

export class AdminError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export const token = {
  get: () => { try { return sessionStorage.getItem(KEY); } catch { return null; } },
  set: (t: string | null) => { try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch { /* private mode */ } },
};

export async function call<T>(path: string, init: { method?: string; body?: unknown; query?: Record<string, string | number> } = {}): Promise<T> {
  const q = init.query ? "?" + new URLSearchParams(Object.entries(init.query).map(([k, v]) => [k, String(v)])) : "";
  const headers: Record<string, string> = { "content-type": "application/json" };
  const t = token.get();
  if (t) headers.authorization = `Bearer ${t}`;
  let res: Response;
  try {
    res = await fetch(`${BASE}/admin${path}${q}`, { method: init.method || (init.body ? "POST" : "GET"), headers,
      body: init.body ? JSON.stringify(init.body) : undefined });
  } catch {
    throw new AdminError(0, "offline", "Can't reach the Bolverse server.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = (data as { detail?: unknown }).detail;
    const detail = typeof d === "object" && d ? (d as { code?: string; message?: string }) : { message: typeof d === "string" ? d : "" };
    if (res.status === 401) token.set(null);
    throw new AdminError(res.status, detail.code || "error", detail.message || `Error ${res.status}`);
  }
  return data as T;
}

export type Role = "owner" | "admin" | "finance" | "support";
export interface Admin { id: string; email: string; name: string; role: Role; active: boolean; permissions: string[]; last_login_at: string | null; created_at: string }
export interface Stats {
  users: number; new_users_24h: number; active_users_24h: number; blocked_users: number; premium_users: number;
  active_by_plan: Record<string, number>; revenue_this_month: { currency: string; amount: number; payments: number }[];
  upi_to_verify: number; active_chats: number; daily: { date: string; signups: number; paid: number }[];
}
export interface UserRow {
  id: string; name: string; phone: string; country: string; language: string; gender: string; blocked: boolean;
  created_at: string; last_login_at: string | null; plan: "premium" | "free"; premium_until: string | null;
  premium_plan: string | null; translations_today: number; translations_total: number;
}
export interface Payment {
  id: string; reference: string; user_id: string; user_name: string; user_phone: string; plan: string; plan_name: string;
  currency: string; amount: number; provider: string; method: string; utr: string | null; status: string; note: string;
  created_at: string; paid_at: string | null;
}
export interface Sub { id: string; plan: string; starts_at: string; ends_at: string; cancelled_at: string | null; payment_id: string; state: string }
export interface UserDetail extends UserRow { dob: string; subscriptions: Sub[]; payments: Payment[] }
export type Paged<T> = { total: number; page: number; page_size: number } & T;
export interface AuditEntry { id: number; admin: string; action: string; target: string; detail: Record<string, unknown>; at: string }
