import { voiceSource, type BolverseApi, type VoiceGender } from "@bolverse/shared";

/* ---------- Recording (sent to the server for Whisper) ---------- */

export class Recorder {
  private rec?: MediaRecorder;
  private stream?: MediaStream;
  private chunks: Blob[] = [];

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find(
      (t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t),
    );
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start();
  }

  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      const rec = this.rec;
      if (!rec || rec.state === "inactive") return resolve(new Blob([]));
      rec.onstop = () => {
        this.release();
        resolve(new Blob(this.chunks, { type: rec.mimeType || "audio/webm" }));
      };
      // Keep listening a moment after the tap so the last word isn't cut off.
      setTimeout(() => { if (rec.state !== "inactive") rec.stop(); }, 350);
    });
  }

  cancel() {
    try { this.rec?.stop(); } catch { /* already stopped */ }
    this.release();
  }

  private release() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
  }
}

export function micErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Microphone access is blocked. Allow it in your browser's site settings, or type instead.";
  if (name === "NotFoundError") return "No microphone found. Plug one in, or type instead.";
  if (!navigator.mediaDevices) return "Recording needs a secure page (https or localhost).";
  return "The microphone couldn't start. Try again, or type instead.";
}

/* ---------- Speaking: server voice first, the browser's voice as fallback ---------- */

let token = 0;
let audioEl: HTMLAudioElement | null = null;
let finishCurrent: (() => void) | null = null;

export function stopSpeaking() {
  token++;
  if (audioEl) { audioEl.pause(); audioEl.removeAttribute("src"); audioEl = null; }
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  finishCurrent?.();
  finishCurrent = null;
}

function playUrl(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const a = new Audio(url);
    audioEl = a;
    finishCurrent = () => resolve(true);
    a.onended = () => resolve(true);
    a.onerror = () => resolve(false);
    a.play().catch(() => resolve(false));
  });
}

// Browsers don't report a voice's gender, so recognise common voice names.
const FEMALE = /female|woman|zira|samantha|karen|moira|tessa|veena|heera|kalpana|swara|lekha|aditi|raveena|neerja|salli|joanna|kendra|kimberly|ivy|amelie|audrey|marie|paulina|monica|helena|lucia|elsa|anna|alice|kyoko|mei-jia|ting-ting|yuna|sara|google uk english female/i;
const MALE = /\bmale|\bman\b|david|mark|daniel|alex|fred|ravi|hemant|madhur|rishi|prabhat|arjun|george|thomas|jorge|diego|juan|pablo|luca|otoya|kenji|yu-shu|hyunsu|google uk english male/i;

function pickVoice(code: string, gender?: VoiceGender | null) {
  const voices = speechSynthesis.getVoices();
  const c = code.toLowerCase(), base = c.split("-")[0];
  const norm = (v: SpeechSynthesisVoice) => v.lang.replace("_", "-").toLowerCase();
  const inLang = voices.filter((v) => norm(v) === c).concat(voices.filter((v) => norm(v) !== c && norm(v).split("-")[0] === base));
  if (gender) {
    const want = gender === "male" ? MALE : FEMALE;
    const avoid = gender === "male" ? FEMALE : MALE;
    const match = inLang.find((v) => want.test(v.name) && !(gender === "male" && FEMALE.test(v.name)));
    if (match) return { voice: match, exact: true };
    const neutral = inLang.find((v) => !avoid.test(v.name));
    if (neutral) return { voice: neutral, exact: false };
  }
  return { voice: inLang[0] ?? null, exact: false };
}

function deviceSpeak(text: string, code: string, rate: number, gender?: VoiceGender | null): Promise<void> {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = code;
    const { voice, exact } = pickVoice(code, gender);
    if (voice) u.voice = voice;
    // No voice of the right gender on this device: shift the pitch so it still sounds closer.
    if (gender && !exact) u.pitch = gender === "male" ? 0.75 : 1.15;
    u.rate = rate;
    finishCurrent = () => resolve();
    u.onend = () => resolve();
    u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

/** Speaks and resolves when finished or interrupted by stopSpeaking(). Server voice first, in the right gender. */
export async function speak(api: BolverseApi, text: string, code: string, rate = 1, gender?: VoiceGender | null): Promise<void> {
  stopSpeaking();
  const mine = token;
  if (!text.trim()) return;
  const genders = await api.voiceGenders(code);
  // The chosen gender must reach a voice that can do it: the server only if it lists that gender.
  const serverFits = voiceSource(genders, gender) === "server";
  if (serverFits) {
    const blob = await api.ttsBlob(text, code, rate, gender);
    if (mine !== token) return;
    if (blob) {
      const url = URL.createObjectURL(blob);
      const played = await playUrl(url);
      URL.revokeObjectURL(url);
      if (played || mine !== token) return;
    }
  }
  if (mine !== token) return;
  await deviceSpeak(text, code, rate, gender);
}
