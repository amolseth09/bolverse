import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built files go to apps/admin/dist and are served by the Bolverse server at /dashboard.
// In development (npm run admin), API calls are forwarded to the server on port 8000.
export default defineConfig({
  base: "/dashboard/",
  plugins: [react()],
  server: { port: 5175, proxy: { "/admin": "http://127.0.0.1:8000" } },
});
