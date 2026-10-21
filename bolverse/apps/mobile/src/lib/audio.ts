import { useRef } from "react";
import {
  AudioModule, createAudioPlayer, RecordingPresets, setAudioModeAsync, useAudioRecorder, useAudioRecorderState,
  type AudioPlayer, type RecordingOptions,
} from "expo-audio";
import * as Speech from "expo-speech";
import { voiceSource, type AudioUpload, type BolverseApi, type VoiceGender } from "@bolverse/shared";

export async function initAudio() {
  await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false }).catch(() => {});
}

/* ---------- Recording (uploaded to the server for Whisper) ---------- */

// Tuned for speech recognition: mono AAC, and on Android the "voice recognition" microphone source,
// which skips the phone-call style noise suppression and auto-gain that smear words.
const SPEECH_PRESET: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  bitRate: 96000,
  isMeteringEnabled: true,
  android: { ...RecordingPresets.HIGH_QUALITY.android, audioSource: "voice_recognition" },
};

const TAIL_MS = 350;   // keep recording briefly after "stop" so the last word isn't cut off
const MIN_MS = 600;    // anything shorter is a mis-tap

export function useRecorder() {
  const recorder = useAudioRecorder(SPEECH_PRESET);
  const state = useAudioRecorderState(recorder, 120);
  const startedAt = useRef(0);
  // metering is in dB (about -60 quiet room to 0 loud); turn it into 0..1 for the level meter.
  const level = state.isRecording && typeof state.metering === "number" ? Math.max(0, Math.min(1, (state.metering + 55) / 45)) : 0;
  return {
    level,
    async start() {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) throw new Error("Microphone access is off. Allow it for Bolverse in Settings, or type instead.");
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      startedAt.current = Date.now();
    },
    async stop(): Promise<AudioUpload> {
      await new Promise((r) => setTimeout(r, TAIL_MS));
      await recorder.stop();
      // Leaving record mode routes playback back to the loudspeaker on iOS.
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
      if (Date.now() - startedAt.current < MIN_MS) throw new Error("That was too short. Tap the mic, speak, then tap again.");
      if (!recorder.uri) throw new Error("The recording couldn't be saved. Try again.");
      return { uri: recorder.uri, name: "speech.m4a", type: "audio/m4a" };
    },
    async cancel() {
      try { await recorder.stop(); } catch { /* not recording */ }
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false }).catch(() => {});
    },
  };
}

/* ---------- Speaking: server voice first, the device voice as fallback ---------- */

let token = 0;
let player: AudioPlayer | null = null;
let finishCurrent: (() => void) | null = null;

function releasePlayer() {
  if (!player) return;
  try { player.pause(); player.remove(); } catch { /* already released */ }
  player = null;
}

export function stopSpeaking() {
  token++;
  releasePlayer();
  Speech.stop();
  finishCurrent?.();
  finishCurrent = null;
}

function playUrl(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const p = createAudioPlayer({ uri: url });
    player = p;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sub.remove();
      if (player === p) releasePlayer();
      resolve(ok);
    };
    finishCurrent = () => done(true);
    const sub = p.addListener("playbackStatusUpdate", (s) => { if (s.didJustFinish) done(true); });
    // If the server voice hasn't loaded in time, fall back to the device voice.
    const timer = setTimeout(() => { if (!p.isLoaded) done(false); }, 15000);
    p.play();
  });
}

// Phones don't label voice gender consistently, so recognise common voice names.
const FEMALE = /female|woman|samantha|karen|moira|tessa|veena|lekha|kyoko|ting-ting|mei-jia|yuna|amelie|monica|paulina|sara|alice|anna|helena|#female|-f-|fem/i;
const MALE = /\bmale|#male|daniel|alex|fred|rishi|aaron|arthur|thomas|jorge|diego|juan|luca|otoya|-m-|masc/i;
let voiceList: Speech.Voice[] | null = null;

async function pickVoice(code: string, gender?: VoiceGender | null): Promise<{ id?: string; exact: boolean }> {
  if (!voiceList) voiceList = await Speech.getAvailableVoicesAsync().catch(() => []);
  const c = code.toLowerCase(), base = c.split("-")[0];
  const norm = (v: Speech.Voice) => v.language.replace("_", "-").toLowerCase();
  const inLang = voiceList.filter((v) => norm(v) === c).concat(voiceList.filter((v) => norm(v) !== c && norm(v).split("-")[0] === base));
  if (gender) {
    const label = (v: Speech.Voice) => `${v.name} ${v.identifier}`;
    const match = inLang.find((v) => (gender === "male" ? MALE : FEMALE).test(label(v)) && !(gender === "male" && FEMALE.test(label(v))));
    if (match) return { id: match.identifier, exact: true };
  }
  return { id: inLang[0]?.identifier, exact: false };
}

async function deviceSpeak(text: string, code: string, rate: number, gender?: VoiceGender | null): Promise<void> {
  const { id, exact } = await pickVoice(code, gender);
  return new Promise((resolve) => {
    finishCurrent = () => resolve();
    Speech.speak(text, {
      language: code, rate, voice: id,
      // No voice of the right gender on this phone: shift the pitch so it still sounds closer.
      pitch: gender && !exact ? (gender === "male" ? 0.75 : 1.15) : 1,
      onDone: resolve, onStopped: resolve, onError: () => resolve(),
    });
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
    if (mine !== token) return;
    if (await playUrl(api.ttsUrl(text, code, rate, gender))) return;
  }
  if (mine !== token) return;
  await deviceSpeak(text, code, rate, gender);
}
