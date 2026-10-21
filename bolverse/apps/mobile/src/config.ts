import { normalizeServerUrl } from "@bolverse/shared";

/**
 * The Bolverse server this app talks to. Users never see or change it.
 * To point the app somewhere else, change DEFAULT_SERVER here, or set EXPO_PUBLIC_API_URL in
 * apps/mobile/.env or in eas.json (for APK builds). The environment value wins.
 */
const DEFAULT_SERVER = "https://grumble-arose-yogurt.ngrok-free.dev";

export const SERVER_URL: string = normalizeServerUrl(process.env.EXPO_PUBLIC_API_URL || DEFAULT_SERVER);
