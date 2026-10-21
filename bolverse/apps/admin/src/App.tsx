import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AdminError, call, token, type Admin, type AuditEntry, type Paged, type Payment, type Stats, type UserDetail, type UserRow } from "./api";

type View = "overview" | "users" | "payments" | "admins" | "audit" | "account";
const can = (a: Admin, p: string) => a.permissions.includes(p);
const dt = (s: string | null | undefined) => (s ? new Date(s).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const day = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—");
const money = (amount: number, currency: string) => (currency === "INR" ? `₹${amount.toLocaleString("en-IN")}` : `$${amount.toFixed(2)}`);
const STATUS_PILL: Record<string, string> = { paid: "good", verifying: "warn", pending: "", rejected: "bad" };

function useToast() {
  const [msg, setMsg] = useState("");
  const show = useCallback((m: string) => { setMsg(m); window.setTimeout(() => setMsg(""), 2600); }, []);
  return { show, node: msg ? <div className="toast" role="status">{msg}</div> : null };
}

function viewFromHash(): View {
  const v = location.hash.replace(/^#\/?/, "").split("/")[0];
  return (["overview", "users", "payments", "admins", "audit", "account"] as View[]).includes(v as View) ? (v as View) : "overview";
}

export function App() {
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<View>(viewFromHash());
  const [pendingUpi, setPendingUpi] = useState(0);
  const toast = useToast();

  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    addEventListener("hashchange", onHash);
    if (token.get()) call<Admin>("/me").then(setAdmin).catch(() => token.set(null)).finally(() => setReady(true));
    else setReady(true);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!admin || !can(admin, "payments.read")) return;
    const load = () => call<Paged<{ payments: Payment[] }>>("/payments", { query: { status: "verifying" } }).then((r) => setPendingUpi(r.total)).catch(() => {});
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [admin, view]);

  if (!ready) return null;
  if (!admin) return <Login onIn={setAdmin} />;

  const go = (v: View) => { location.hash = `#/${v}`; };
  const nav: { id: View; label: string; perm?: string; badge?: number }[] = [
    { id: "overview", label: "Overview", perm: "stats.read" },
    { id: "users", label: "Users", perm: "users.read" },
    { id: "payments", label: "Payments", perm: "payments.read", badge: pendingUpi },
    { id: "admins", label: "Dashboard users", perm: "admins.manage" },
    { id: "audit", label: "Audit log", perm: "audit.read" },
    { id: "account", label: "My account" },
  ];
  const allowed = nav.filter((n) => !n.perm || can(admin, n.perm));
  const current = allowed.some((n) => n.id === view) ? view : allowed[0].id;

  async function logout() {
    await call("/logout", { method: "POST" }).catch(() => {});
    token.set(null);
    setAdmin(null);
  }

  return (
    <div className="layout">
      <aside className="side">
        <div className="brand"><img src={`${import.meta.env.BASE_URL}logo.png`} alt="" width={28} height={28} /> Bolverse <small>admin</small></div>
        {allowed.map((n) => (
          <a key={n.id} href={`#/${n.id}`} className={`nav ${current === n.id ? "on" : ""}`} aria-current={current === n.id ? "page" : undefined}>
            {n.label}{n.badge ? <span className="badge" aria-label={`${n.badge} to verify`}>{n.badge}</span> : null}
          </a>
        ))}
        <div className="me">
          <b>{admin.name}</b>
          <span className="muted" style={{ fontSize: 12, wordBreak: "break-all" }}>{admin.email}</span>
          <span><span className="role">{admin.role}</span></span>
          <button className="btn small" onClick={logout}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        {current === "overview" && <Overview go={go} />}
        {current === "users" && <Users admin={admin} toast={toast.show} />}
        {current === "payments" && <Payments admin={admin} toast={toast.show} onChange={() => setPendingUpi((n) => Math.max(0, n - 1))} />}
        {current === "admins" && <Admins me={admin} toast={toast.show} />}
        {current === "audit" && <Audit />}
        {current === "account" && <Account admin={admin} toast={toast.show} onOut={logout} />}
      </main>
      {toast.node}
    </div>
  );
}

// ---------- Sign in ----------

function Login({ onIn }: { onIn: (a: Admin) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const r = await call<{ token: string; admin: Admin }>("/login", { body: { email, password } });
      token.set(r.token);
      onIn(r.admin);
    } catch (x) { setErr((x as Error).message); }
    setBusy(false);
  }
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="brand" style={{ padding: 0 }}><img src={`${import.meta.env.BASE_URL}logo.png`} alt="" width={28} height={28} /> Bolverse <small>admin</small></div>
        <h1>Sign in</h1>
        <label>Email<input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Password<input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {err && <div className="err" role="alert">{err}</div>}
        <button className="btn primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </div>
  );
}

// ---------- Overview ----------

function Overview({ go }: { go: (v: View) => void }) {
  const [s, setS] = useState<Stats | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { call<Stats>("/stats").then(setS).catch((e) => setErr(e.message)); }, []);
  if (err) return <p className="err">{err}</p>;
  if (!s) return <p className="muted">Loading…</p>;
  const max = Math.max(1, ...s.daily.flatMap((d) => [d.signups, d.paid]));
  const plans = ["day", "week", "month"];
  return (
    <>
      <div className="head"><div><h1>Overview</h1><span className="muted">Live numbers from the database.</span></div></div>
      {s.upi_to_verify > 0 && (
        <div className="card tile alert" style={{ marginBottom: 16 }} onClick={() => go("payments")} role="button" tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && go("payments")}>
          <b>{s.upi_to_verify} UPI {s.upi_to_verify === 1 ? "payment is" : "payments are"} waiting for you to verify.</b>
          <span className="muted"> Check each transaction ID in your bank app, then approve. Open Payments →</span>
        </div>
      )}
      <div className="grid">
        <Tile label="Users" value={s.users} sub={`${s.new_users_24h} new in 24 h`} />
        <Tile label="Active in 24 h" value={s.active_users_24h} />
        <Tile label="Premium now" value={s.premium_users} sub={plans.map((p) => `${s.active_by_plan[p] || 0} ${p}`).join(" · ")} />
        {(s.revenue_this_month.length ? s.revenue_this_month : [{ currency: "INR", amount: 0, payments: 0 }]).map((r) => (
          <Tile key={r.currency} label={`Revenue this month (${r.currency})`} value={money(r.amount, r.currency)} sub={`${r.payments} ${r.payments === 1 ? "payment" : "payments"}`} />
        ))}
        <Tile label="Open chats" value={s.active_chats} />
        <Tile label="Blocked users" value={s.blocked_users} />
      </div>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
          <h2 style={{ margin: 0 }}>Last 14 days</h2>
          <div className="legend"><span style={{ ["--c" as string]: "var(--you)" }}>Sign-ups</span><span style={{ ["--c" as string]: "var(--them)" }}>Paid passes</span></div>
        </div>
        <div className="chart" role="img" aria-label="Sign-ups and paid passes per day for the last 14 days">
          {s.daily.map((d) => (
            <div className="day" key={d.date} title={`${d.date}: ${d.signups} sign-ups, ${d.paid} paid`}>
              <div className="bars">
                <div className="bar" style={{ height: `${(d.signups / max) * 100}%`, background: "var(--you)" }} />
                <div className="bar" style={{ height: `${(d.paid / max) * 100}%`, background: "var(--them)" }} />
              </div>
              <span className="lbl">{d.date.slice(8)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function Tile({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return <div className="card tile"><div className="label">{label}</div><div className="value num">{value}</div>{sub && <div className="sub">{sub}</div>}</div>;
}

// ---------- Users ----------

function Users({ admin, toast }: { admin: Admin; toast: (m: string) => void }) {
  const [q, setQ] = useState("");
  const [plan, setPlan] = useState("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged<{ users: UserRow[] }> | null>(null);
  const [open, setOpen] = useState<string | null>(location.hash.split("/")[2] || null);
  const load = useCallback(() => {
    call<Paged<{ users: UserRow[] }>>("/users", { query: { q, plan, page } }).then(setData).catch((e) => toast(e.message));
  }, [q, plan, page, toast]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
  return (
    <>
      <div className="head"><div><h1>Users</h1><span className="muted">{data ? `${data.total} found` : ""}</span></div></div>
      <div className="toolbar">
        <input className="input" style={{ flex: "1 1 260px" }} placeholder="Search by name or mobile number" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} aria-label="Search users" />
        <div className="tabs" style={{ margin: 0 }}>
          {["all", "premium", "free", "blocked"].map((p) => <button key={p} className={plan === p ? "on" : ""} onClick={() => { setPlan(p); setPage(1); }}>{p[0].toUpperCase() + p.slice(1)}</button>)}
        </div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Mobile</th><th>Language</th><th>Plan</th><th>Today</th><th>Joined</th></tr></thead>
            <tbody>
              {data?.users.map((u) => (
                <tr key={u.id} className="click" onClick={() => setOpen(u.id)}>
                  <td><b>{u.name}</b> {u.blocked && <span className="pill bad">Blocked</span>}</td>
                  <td className="num">{u.phone}</td>
                  <td>{u.language}</td>
                  <td>{u.plan === "premium" ? <span className="pill you">Premium ({u.premium_plan}) to {day(u.premium_until)}</span> : <span className="pill">Free</span>}</td>
                  <td className="num">{u.translations_today}</td>
                  <td>{day(u.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && data.users.length === 0 && <div className="empty">No users match.</div>}
        </div>
      </div>
      {data && <Pager page={page} size={data.page_size} total={data.total} onPage={setPage} />}
      {open && <UserDrawer id={open} admin={admin} toast={toast} onClose={() => setOpen(null)} onChanged={load} />}
    </>
  );
}

function UserDrawer({ id, admin, toast, onClose, onChanged }: { id: string; admin: Admin; toast: (m: string) => void; onClose: () => void; onChanged: () => void }) {
  const [u, setU] = useState<UserDetail | null>(null);
  const [plan, setPlan] = useState("week");
  const [days, setDays] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { call<UserDetail>(`/users/${id}`).then(setU).catch((e) => toast(e.message)); }, [id, toast]);
  useEffect(load, [load]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try { await fn(); toast(done); load(); onChanged(); } catch (e) { toast((e as Error).message); }
    setBusy(false);
  }
  const subsWrite = can(admin, "subs.write");
  return (
    <div className="drawer-bg" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="User details">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h1>{u?.name || "…"}</h1><button className="btn small" onClick={onClose}>Close</button>
        </div>
        {u && (
          <>
            <div className="card">
              <dl className="kv">
                <dt>Mobile</dt><dd className="num">{u.phone}</dd>
                <dt>Status</dt><dd>{u.blocked ? <span className="pill bad">Blocked</span> : u.plan === "premium" ? <span className="pill you">Premium until {dt(u.premium_until)}</span> : <span className="pill">Free</span>}</dd>
                <dt>Gender / language</dt><dd>{u.gender || "—"} · {u.language} · {u.country}</dd>
                <dt>Date of birth</dt><dd>{day(u.dob)}</dd>
                <dt>Translations</dt><dd className="num">{u.translations_today} today · {u.translations_total} total</dd>
                <dt>Joined</dt><dd>{dt(u.created_at)}</dd>
                <dt>Last sign-in</dt><dd>{dt(u.last_login_at)}</dd>
                <dt>User ID</dt><dd className="num" style={{ fontSize: 12 }}>{u.id}</dd>
              </dl>
            </div>
            {subsWrite && (
              <div className="card">
                <h2>Give a pass</h2>
                <div className="row">
                  <select className="input" value={plan} onChange={(e) => setPlan(e.target.value)} aria-label="Plan">
                    <option value="day">1 day</option><option value="week">1 week</option><option value="month">1 month</option>
                  </select>
                  <input className="input" style={{ width: 120 }} placeholder="Custom days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} aria-label="Custom days" />
                  <input className="input" style={{ flex: 1 }} placeholder="Reason (saved in the audit log)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Reason" />
                  <button className="btn primary" disabled={busy} onClick={() => act(() => call(`/users/${id}/grant`, { body: { plan, days: days ? Number(days) : undefined, note } }), "Pass added")}>Add</button>
                </div>
                <p className="muted" style={{ margin: "8px 0 0" }}>Added after any time they already have. Recorded as a ₹0 payment marked “grant”.</p>
              </div>
            )}
            <div className="card">
              <h2>Passes</h2>
              {u.subscriptions.length === 0 ? <p className="muted">None yet.</p> : (
                <table><tbody>
                  {u.subscriptions.map((s) => (
                    <tr key={s.id}>
                      <td><b>{s.plan}</b></td>
                      <td>{day(s.starts_at)} → {day(s.ends_at)}</td>
                      <td><span className={`pill ${s.state === "active" ? "good" : s.state === "cancelled" ? "bad" : ""}`}>{s.state}</span></td>
                      <td style={{ textAlign: "right" }}>
                        {subsWrite && (s.state === "active" || s.state === "upcoming") && (
                          <button className="btn small bad" disabled={busy} onClick={() => confirm(`Cancel this ${s.plan} pass?`) && act(() => call(`/users/${id}/cancel-subscription`, { body: { subscription_id: s.id } }), "Pass cancelled")}>Cancel</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody></table>
              )}
            </div>
            <div className="card">
              <h2>Payments</h2>
              {u.payments.length === 0 ? <p className="muted">None yet.</p> : (
                <table><tbody>
                  {u.payments.map((p) => (
                    <tr key={p.id}>
                      <td className="num">{p.reference}</td>
                      <td>{p.plan_name}</td>
                      <td className="num">{money(p.amount, p.currency)}</td>
                      <td>{p.method}{p.utr ? <span className="muted num"> · {p.utr}</span> : null}</td>
                      <td><span className={`pill ${STATUS_PILL[p.status] ?? ""}`}>{p.status}</span></td>
                    </tr>
                  ))}
                </tbody></table>
              )}
            </div>
            {can(admin, "users.write") && (
              <div className="card">
                <h2>{u.blocked ? "Unblock" : "Block"} this user</h2>
                <p className="muted">{u.blocked ? "They'll be able to sign in again." : "Signs them out on every device, ends their chats and stops them signing in."}</p>
                <button className={`btn ${u.blocked ? "" : "bad"}`} disabled={busy}
                  onClick={() => confirm(u.blocked ? `Unblock ${u.name}?` : `Block ${u.name}?`) && act(() => call(`/users/${id}/block`, { body: { blocked: !u.blocked } }), u.blocked ? "Unblocked" : "Blocked")}>
                  {u.blocked ? "Unblock" : "Block user"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------- Payments ----------

function Payments({ admin, toast, onChange }: { admin: Admin; toast: (m: string) => void; onChange: () => void }) {
  const [status, setStatus] = useState("verifying");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged<{ payments: Payment[] }> | null>(null);
  const [busy, setBusy] = useState("");
  const load = useCallback(() => {
    call<Paged<{ payments: Payment[] }>>("/payments", { query: { status, q, page } }).then(setData).catch((e) => toast(e.message));
  }, [status, q, page, toast]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
  const verify = can(admin, "payments.verify");

  async function review(p: Payment, ok: boolean) {
    let reason = "";
    if (ok) {
      if (!confirm(`Approve ${money(p.amount, p.currency)} from ${p.user_name}?\n\nOnly approve if UPI transaction ${p.utr ?? "(none)"} shows as received in your bank app.`)) return;
    } else {
      const r = prompt("Reason for rejecting (the customer sees this):", "Payment not received");
      if (r === null) return;
      reason = r;
    }
    setBusy(p.id);
    try {
      await call(`/payments/${p.id}/${ok ? "approve" : "reject"}`, { body: ok ? {} : { reason } });
      toast(ok ? "Approved: Premium is active" : "Rejected");
      onChange();
      load();
    } catch (e) { toast((e as Error).message); }
    setBusy("");
  }

  return (
    <>
      <div className="head"><div><h1>Payments</h1><span className="muted">UPI payments go straight to your bank account; approve them here once the money shows up.</span></div></div>
      <div className="toolbar">
        <div className="tabs" style={{ margin: 0 }}>
          {[["verifying", "To verify"], ["paid", "Paid"], ["rejected", "Rejected"], ["pending", "Started, not paid"], ["all", "All"]].map(([v, l]) => (
            <button key={v} className={status === v ? "on" : ""} onClick={() => { setStatus(v); setPage(1); }}>{l}</button>
          ))}
        </div>
        <input className="input" style={{ flex: "1 1 240px" }} placeholder="Search UTR, reference (BV…), name or mobile" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} aria-label="Search payments" />
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Customer</th><th>Pass</th><th>Amount</th><th>Method</th><th>UPI transaction ID</th><th>Status</th>{verify && status === "verifying" && <th />}</tr></thead>
            <tbody>
              {data?.payments.map((p) => (
                <tr key={p.id}>
                  <td>{dt(p.created_at)}<div className="muted num" style={{ fontSize: 12 }}>{p.reference}</div></td>
                  <td><b>{p.user_name}</b><div className="muted num" style={{ fontSize: 12 }}>{p.user_phone}</div></td>
                  <td>{p.plan_name}</td>
                  <td className="num"><b>{money(p.amount, p.currency)}</b></td>
                  <td>{p.method === "upi" ? "UPI direct" : p.method === "grant" ? "Granted" : `${p.provider}`}</td>
                  <td className="num">{p.utr ?? "—"}</td>
                  <td><span className={`pill ${STATUS_PILL[p.status] ?? ""}`}>{p.status}</span>{p.note && p.status === "rejected" && <div className="muted" style={{ fontSize: 12 }}>{p.note}</div>}</td>
                  {verify && status === "verifying" && (
                    <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                      <button className="btn small good" disabled={busy === p.id} onClick={() => review(p, true)}>Approve</button>{" "}
                      <button className="btn small bad" disabled={busy === p.id} onClick={() => review(p, false)}>Reject</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {data && data.payments.length === 0 && <div className="empty">{status === "verifying" ? "Nothing to verify. All caught up." : "No payments here."}</div>}
        </div>
      </div>
      {data && <Pager page={page} size={data.page_size} total={data.total} onPage={setPage} />}
    </>
  );
}

// ---------- Dashboard users ----------

const ROLE_HELP: Record<string, string> = {
  owner: "Everything, including dashboard users",
  admin: "Users, passes, payments, statistics, audit log",
  finance: "Payments (approve UPI), statistics, view users",
  support: "View users and payments only",
};

function Admins({ me, toast }: { me: Admin; toast: (m: string) => void }) {
  const [list, setList] = useState<Admin[]>([]);
  const [form, setForm] = useState({ email: "", name: "", role: "support", password: "" });
  const [err, setErr] = useState("");
  const load = useCallback(() => { call<Admin[]>("/admins").then(setList).catch((e) => toast(e.message)); }, [toast]);
  useEffect(load, [load]);
  async function add(e: React.FormEvent) {
    e.preventDefault(); setErr("");
    try { await call("/admins", { body: form }); toast("Dashboard user added"); setForm({ email: "", name: "", role: "support", password: "" }); load(); }
    catch (x) { setErr((x as Error).message); }
  }
  async function patch(a: Admin, body: Record<string, unknown>, done: string) {
    try { await call(`/admins/${a.id}`, { method: "PATCH", body }); toast(done); load(); } catch (x) { toast((x as Error).message); }
  }
  return (
    <>
      <div className="head"><div><h1>Dashboard users</h1><span className="muted">Who can sign in here, and what they can do.</span></div></div>
      <div className="card" style={{ padding: 0, marginBottom: 16 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th><th /></tr></thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id}>
                  <td><b>{a.name}</b>{a.id === me.id && <span className="muted"> (you)</span>} {!a.active && <span className="pill bad">Disabled</span>}</td>
                  <td>{a.email}</td>
                  <td>
                    <select className="input" value={a.role} disabled={a.id === me.id} onChange={(e) => patch(a, { role: e.target.value }, "Role changed")} aria-label={`Role for ${a.email}`}>
                      {Object.keys(ROLE_HELP).map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                  <td>{dt(a.last_login_at)}</td>
                  <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                    <button className="btn small" onClick={() => { const pw = prompt(`New password for ${a.email} (10+ characters, letters and numbers):`); if (pw) patch(a, { password: pw }, "Password reset"); }}>Reset password</button>{" "}
                    {a.id !== me.id && <button className={`btn small ${a.active ? "bad" : ""}`} onClick={() => patch(a, { active: !a.active }, a.active ? "Disabled" : "Enabled")}>{a.active ? "Disable" : "Enable"}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <form className="card" onSubmit={add} style={{ display: "grid", gap: 10, maxWidth: 560 }}>
        <h2>Add a dashboard user</h2>
        <input className="input" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required aria-label="Name" />
        <input className="input" type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required aria-label="Email" />
        <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} aria-label="Role">
          {Object.entries(ROLE_HELP).map(([r, h]) => <option key={r} value={r}>{r}: {h}</option>)}
        </select>
        <input className="input" type="password" autoComplete="new-password" placeholder="Temporary password (10+ characters, letters and numbers)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required aria-label="Temporary password" />
        {err && <div className="err">{err}</div>}
        <div><button className="btn primary">Add user</button></div>
        <span className="muted">Share the password privately. They can change it under My account.</span>
      </form>
    </>
  );
}

// ---------- Audit log ----------

function Audit() {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged<{ entries: AuditEntry[] }> | null>(null);
  useEffect(() => { call<Paged<{ entries: AuditEntry[] }>>("/audit", { query: { page } }).then(setData).catch(() => {}); }, [page]);
  return (
    <>
      <div className="head"><div><h1>Audit log</h1><span className="muted">Every change made from this dashboard.</span></div></div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Target</th><th>Details</th></tr></thead>
            <tbody>
              {data?.entries.map((e) => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{dt(e.at)}</td><td>{e.admin}</td><td><span className="pill">{e.action}</span></td>
                  <td className="num" style={{ fontSize: 12 }}>{e.target}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{Object.entries(e.detail).filter(([, v]) => v !== "" && v != null).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(" → ") : v}`).join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {data && <Pager page={page} size={data.page_size} total={data.total} onPage={setPage} />}
    </>
  );
}

// ---------- My account ----------

function Account({ admin, toast, onOut }: { admin: Admin; toast: (m: string) => void; onOut: () => void }) {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [err, setErr] = useState("");
  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr("");
    try { await call("/me/password", { body: { current: cur, new: next } }); toast("Password changed"); setCur(""); setNext(""); }
    catch (x) { setErr((x as AdminError).message); }
  }
  const perms = useMemo(() => admin.permissions.join(", "), [admin]);
  return (
    <>
      <div className="head"><div><h1>My account</h1></div></div>
      <div className="card" style={{ maxWidth: 560, marginBottom: 16 }}>
        <dl className="kv"><dt>Name</dt><dd>{admin.name}</dd><dt>Email</dt><dd>{admin.email}</dd><dt>Role</dt><dd><span className="role">{admin.role}</span></dd><dt>Can</dt><dd className="muted">{perms}</dd></dl>
      </div>
      <form className="card" onSubmit={save} style={{ maxWidth: 560, display: "grid", gap: 10 }}>
        <h2>Change password</h2>
        <input className="input" type="password" autoComplete="current-password" placeholder="Current password" value={cur} onChange={(e) => setCur(e.target.value)} required aria-label="Current password" />
        <input className="input" type="password" autoComplete="new-password" placeholder="New password (10+ characters, letters and numbers)" value={next} onChange={(e) => setNext(e.target.value)} required aria-label="New password" />
        {err && <div className="err">{err}</div>}
        <div className="row"><button className="btn primary">Change password</button><button type="button" className="btn" onClick={onOut}>Sign out</button></div>
      </form>
    </>
  );
}

function Pager({ page, size, total, onPage }: { page: number; size: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return null;
  return (
    <div className="pager">
      <button className="btn small" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
      <span className="muted num">Page {page} of {pages}</span>
      <button className="btn small" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
    </div>
  );
}
