import { detectLang, newDeviceId, otherThan, parseTokens, regionOf, type Profile, type Thread, type Tokens } from "@bolverse/shared";

const PREFS_KEY = "bolverse:prefs";
const DEVICE_KEY = "bolverse:device";
const TOKEN_KEY = "bolverse:token";

export { SERVER_URL } from "../config";

export function browserLang(): string {
  return detectLang(navigator.languages?.length ? navigator.languages : [navigator.language || "en-US"]);
}

export function browserRegion(): string {
  return regionOf(navigator.language || "");
}

function read<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
function write(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

export function defaultPrefs(): Profile {
  const me = browserLang();
  return { rate: 1, speakTheirs: true, myLang: me,
           askTarget: otherThan(me), target: otherThan(me) };
}

export function loadPrefs(): Profile {
  const { serverUrl: _s, apiKey: _k, ...saved } = read<Partial<Profile> & { serverUrl?: string; apiKey?: string }>(PREFS_KEY, {});
  return { ...defaultPrefs(), ...saved };
}
export const savePrefs = (p: Profile) => write(PREFS_KEY, p);

export function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) { id = newDeviceId(); localStorage.setItem(DEVICE_KEY, id); }
    return id;
  } catch { return newDeviceId(); }
}

/** Access and refresh token. A browser has no safer place than localStorage for a single-page app; the
 *  access token lives 15 minutes and the refresh token is bound to this browser's device ID. */
export function loadTokens(): Tokens | null {
  try { return parseTokens(localStorage.getItem(TOKEN_KEY)); } catch { return null; }
}
export function saveTokens(tokens: Tokens | null) {
  try { tokens ? localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens)) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

const GUEST_KEY = "bolverse:guest";
/** The visitor chose "Try it without an account" on the welcome screen. */
export function loadGuestChoice(): boolean {
  try { return localStorage.getItem(GUEST_KEY) === "1"; } catch { return false; }
}
export function saveGuestChoice(on: boolean) {
  try { on ? localStorage.setItem(GUEST_KEY, "1") : localStorage.removeItem(GUEST_KEY); } catch { /* ignore */ }
}

/* ---------- Chat history: only in this browser, one list per account ---------- */

const historyKey = (owner: string) => `bolverse:history:${owner}`;
export const loadThreads = (owner: string) => read<Thread[]>(historyKey(owner), []);
export const saveThreads = (owner: string, threads: Thread[]) => write(historyKey(owner), threads);
export function clearThreads(owner: string) {
  try { localStorage.removeItem(historyKey(owner)); } catch { /* ignore */ }
}
