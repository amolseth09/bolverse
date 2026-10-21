import type { ReactNode } from "react";
import { LANGUAGES, REGIONS } from "@bolverse/shared";

const LOGO_SRC = `${import.meta.env.BASE_URL}logo.png`;

/** The Bolverse app icon. */
export function Logo({ size = 30 }: { size?: number }) {
  return <img className="logo" src={LOGO_SRC} width={size} height={size} alt="" aria-hidden="true" />;
}

/** Bolverse's AI face: a glowing aurora orb with a sparkle. Spins a halo while it is thinking. */
export function BotAvatar({ size = 36, thinking = false }: { size?: number; thinking?: boolean }) {
  return (
    <span className={"bot-avatar" + (thinking ? " thinking" : "")} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 24 24" width={Math.round(size * 0.52)} height={Math.round(size * 0.52)} fill="#fff">
        <path d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9z" />
        <path d="M18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" opacity=".85" />
      </svg>
    </span>
  );
}

/** Small "AI" tag used next to AI-powered features. */
export function AiTag({ children = "AI" }: { children?: ReactNode }) {
  return <span className="ai-tag">{children}</span>;
}

export function Wordmark() {
  return <div className="brand"><Logo size={34} /><span>Bolverse</span><AiTag /></div>;
}

export function LangSelect(props: {
  id?: string; value: string; onChange: (code: string) => void; exclude?: string; label: string; className?: string;
}) {
  return (
    <select id={props.id} className={props.className} value={props.value} aria-label={props.label}
      onChange={(e) => props.onChange(e.target.value)}>
      {REGIONS.map((region) => (
        <optgroup key={region} label={region}>
          {LANGUAGES.filter((l) => l.region === region && l.code !== props.exclude).map((l) => (
            <option key={l.code} value={l.code}>{l.name} ({l.native})</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export function Chip({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <button type="button" className="chip" onClick={onClick}>{children}</button>;
}

const svg = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;
export const Icon = {
  mic: <svg viewBox="0 0 24 24" {...svg} aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>,
  stop: <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>,
  send: <svg viewBox="0 0 24 24" {...svg} aria-hidden="true"><path d="M4 12l16-8-6 16-2-7z" /></svg>,
  speaker: <svg viewBox="0 0 24 24" {...svg} aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z" /><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" /></svg>,
  slow: <svg viewBox="0 0 24 24" {...svg} aria-hidden="true"><path d="M3 15c0-4 3-7 7-7s7 3 7 7H3zM17 13h2a2 2 0 0 0 2-2M6 15v2M14 15v2" /></svg>,
  copy: <svg viewBox="0 0 24 24" {...svg} aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>,
  swap: <svg viewBox="0 0 24 24" {...svg} aria-hidden="true"><path d="M7 7h12l-3-3M17 17H5l3 3" /></svg>,
  sparkle: <svg viewBox="0 0 24 24" {...svg} aria-hidden="true"><path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2zM19 15l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" /></svg>,
  chat: <svg viewBox="0 0 24 24" {...svg} aria-hidden="true"><path d="M4 5h11v8H8l-4 3z" /><path d="M15 9h5v8l-3-2h-6v-2" /></svg>,
  history: <svg viewBox="0 0 24 24" {...svg} aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></svg>,
  user: <svg viewBox="0 0 24 24" {...svg} aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4-6 8-6s7 2 8 6" /></svg>,
  globe: <svg viewBox="0 0 24 24" {...svg} aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>,
  plus: <svg viewBox="0 0 24 24" {...svg} aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>,
  trash: <svg viewBox="0 0 24 24" {...svg} aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>,
  back: <svg viewBox="0 0 24 24" {...svg} strokeWidth={2.2} aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>,
  lock: <svg viewBox="0 0 24 24" {...svg} aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>,
  check: <svg viewBox="0 0 24 24" {...svg} strokeWidth={2.4} aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>,
  qr: <svg viewBox="0 0 24 24" {...svg} aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM20 14v1M14 20h1M17 17h4v4h-4" /></svg>,
  link: <svg viewBox="0 0 24 24" {...svg} aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>,
  unlink: <svg viewBox="0 0 24 24" {...svg} aria-hidden="true"><path d="M9 15l6-6M7 12l-2 2a4 4 0 0 0 5 5l2-2M17 12l2-2a4 4 0 0 0-5-5l-2 2" /><path d="M4 4l16 16" /></svg>,
  gear: <svg viewBox="0 0 24 24" {...svg} aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>,
};
