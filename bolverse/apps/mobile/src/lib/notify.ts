import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import type { BolverseApi } from "@bolverse/shared";

/**
 * Notifications for Connect.
 * - While Bolverse is open, new messages are read aloud and, if you're on another screen, shown as a banner.
 * - When Bolverse is closed, the server sends a push through Firebase saying only "You have a new
 *   message" (never the text). That needs google-services.json (see the guide); without it,
 *   everything else still works and messages arrive when you open the app.
 */
let ready = false;
export let currentChatId: string | null = null;
export function setCurrentChat(id: string | null) { currentChatId = id; }

Notifications.setNotificationHandler({
  handleNotification: async (n) => {
    const chat = (n.request.content.data as { connection_id?: string } | undefined)?.connection_id;
    const inThisChat = !!chat && chat === currentChatId;
    return { shouldShowBanner: !inThisChat, shouldShowList: !inThisChat, shouldPlaySound: !inThisChat, shouldSetBadge: false };
  },
});

export async function setupNotifications(): Promise<boolean> {
  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("messages", {
        name: "Messages", importance: Notifications.AndroidImportance.HIGH, vibrationPattern: [0, 200, 120, 200],
      });
    }
    const current = await Notifications.getPermissionsAsync();
    const granted = current.granted || (await Notifications.requestPermissionsAsync()).granted;
    ready = granted;
    return granted;
  } catch {
    return false;
  }
}

/** A banner on this phone (used while Bolverse is open but you're not looking at that chat). */
export async function showLocal(title: string, body: string, connectionId: string) {
  if (!ready) return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title, body, data: { connection_id: connectionId }, ...(Platform.OS === "android" ? { channelId: "messages" } : {}) },
      trigger: null,
    });
  } catch { /* notifications off */ }
}

/** Registers this phone for pushes when Firebase is set up; quietly does nothing otherwise. */
export async function registerPush(api: BolverseApi): Promise<string | null> {
  if (!ready || Platform.OS !== "android") return null;
  try {
    const { data } = await Notifications.getDevicePushTokenAsync();
    if (typeof data === "string" && data.length > 10) {
      await api.registerPush(data, Platform.OS);
      return data;
    }
  } catch { /* no google-services.json in this build */ }
  return null;
}

/** Calls back with the chat id when a Bolverse notification is tapped (also for the one that opened the app). */
export function onNotificationTap(cb: (connectionId: string) => void): () => void {
  const pick = (r: Notifications.NotificationResponse | null) => {
    const id = (r?.notification.request.content.data as { connection_id?: string } | undefined)?.connection_id;
    if (id) cb(id);
  };
  void Notifications.getLastNotificationResponseAsync().then(pick).catch(() => {});
  const sub = Notifications.addNotificationResponseReceivedListener(pick);
  return () => sub.remove();
}
