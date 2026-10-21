import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { getLocales } from "expo-localization";
import { detectLang, newDeviceId, otherThan, parseTokens, type Profile, type Thread, type Tokens } from "@bolverse/shared";

const PREFS_KEY = "bolverse:prefs";
const DEVICE_KEY = "bolverse:device";
const TOKEN_KEY = "bolverse_token";

/** Where the Bolverse server is. Set once at build time in apps/mobile/.env (EXPO_PUBLIC_API_URL); users never see it. */
export { SERVER_URL } from "../config";

export function deviceLang(): string {
  return detectLang(getLocales().map((l) => l.languageTag));
}

export function deviceRegion(): string {
  return (getLocales()[0]?.regionCode ?? "").toUpperCase();
}

export function defaultPrefs(): Profile {
  const me = deviceLang();
  return { rate: 1, speakTheirs: true, myLang: me,
           askTarget: otherThan(me), target: otherThan(me) };
}

export async function loadPrefs(): Promise<Profile> {
  try {
    const { serverUrl: _s, apiKey: _k, ...saved } = JSON.parse((await AsyncStorage.getItem(PREFS_KEY)) || "{}");
    return { ...defaultPrefs(), ...saved };
  } catch {
    return defaultPrefs();
  }
}
export function savePrefs(p: Profile) {
  AsyncStorage.setItem(PREFS_KEY, JSON.stringify(p)).catch(() => {});
}

export async function loadDeviceId(): Promise<string> {
  try {
    let id = await AsyncStorage.getItem(DEVICE_KEY);
    if (!id) { id = newDeviceId(); await AsyncStorage.setItem(DEVICE_KEY, id); }
    return id;
  } catch { return newDeviceId(); }
}

/** Access and refresh tokens live in the Keychain / Keystore (expo-secure-store), not plain storage. */
export async function loadTokens(): Promise<Tokens | null> {
  try { return parseTokens(await SecureStore.getItemAsync(TOKEN_KEY)); } catch { return null; }
}
export function saveTokens(tokens: Tokens | null) {
  (tokens ? SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(tokens)) : SecureStore.deleteItemAsync(TOKEN_KEY)).catch(() => {});
}

const GUEST_KEY = "bolverse:guest";
/** The person chose "Try it without an account" on the welcome screen. */
export async function loadGuestChoice(): Promise<boolean> {
  try { return (await AsyncStorage.getItem(GUEST_KEY)) === "1"; } catch { return false; }
}
export function saveGuestChoice(on: boolean) {
  (on ? AsyncStorage.setItem(GUEST_KEY, "1") : AsyncStorage.removeItem(GUEST_KEY)).catch(() => {});
}

/* ---------- Chat history: only on this phone, one list per account ---------- */

const historyKey = (owner: string) => `bolverse:history:${owner}`;
export async function loadThreads(owner: string): Promise<Thread[]> {
  try { return JSON.parse((await AsyncStorage.getItem(historyKey(owner))) || "[]"); } catch { return []; }
}
export function saveThreads(owner: string, threads: Thread[]) {
  AsyncStorage.setItem(historyKey(owner), JSON.stringify(threads)).catch(() => {});
}
export function clearThreads(owner: string) {
  AsyncStorage.removeItem(historyKey(owner)).catch(() => {});
}
