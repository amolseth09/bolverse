import { normalizeServerUrl } from "@bolverse/shared";

/**
 * The Bolverse server this app talks to. Users never see or change it.
 * To point the app somewhere else, change DEFAULT_SERVER here, or set VITE_API_URL in apps/web/.env
 * (the .env value wins), then rebuild or restart `npm run web`.
 */
const DEFAULT_SERVER = "https://grumble-arose-yogurt.ngrok-free.dev";

export const SERVER_URL: string = normalizeServerUrl(import.meta.env.VITE_API_URL || DEFAULT_SERVER);
