import { Alert } from "react-native";

// Loaded before anything else (see index.ts), so even errors while the app's code is starting up
// are shown on screen instead of Android closing Bolverse with "Something went wrong".
type Handler = (error: unknown, isFatal?: boolean) => void;
const errorUtils = (globalThis as unknown as { ErrorUtils?: { getGlobalHandler(): Handler; setGlobalHandler(h: Handler): void } }).ErrorUtils;

export function describeError(error: unknown): string {
  const e = error as { name?: string; message?: string; stack?: string };
  const stack = String(e?.stack ?? "").split("\n").slice(0, 10).join("\n");
  return `${e?.name ?? "Error"}: ${e?.message ?? String(error)}\n\n${stack}`;
}

if (errorUtils) {
  const previous = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, isFatal) => {
    try {
      Alert.alert("Bolverse hit a problem", `${describeError(error)}\n\nPlease screenshot this and send it to the developer.`);
    } catch { /* nothing more we can do */ }
    if (!isFatal) previous(error, isFatal);
  });
}
