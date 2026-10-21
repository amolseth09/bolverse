"""Audio in and out.

In: any format ffmpeg reads (webm/opus from browsers, m4a from phones), cleaned up (rumble and hiss
filtered, background noise reduced, long silences trimmed) and returned as 16 kHz mono float32.
Out: 16-bit WAV. Also estimates whether a voice sounds male or female from its pitch.
"""
from __future__ import annotations

import io
import logging
import os
import subprocess
import tempfile
import wave

import numpy as np

from .config import settings

ASR_SAMPLE_RATE = 16_000
log = logging.getLogger("bolverse")

# Gentle on purpose: heavy denoising and cutting every pause clipped soft word endings, which hurt
# recognition more than the noise did. Whisper's own voice detector skips the remaining silence.
# highpass: remove rumble/handling noise; afftdn: light noise reduction; silenceremove: trim the
# silence before speech and cut long pauses down to about a second (never cutting into words);
# dynaudnorm: lift quiet or far-away voices; apad: a short tail so the last word isn't cut off.
CLEANUP = (
    "highpass=f=70,afftdn=nf=-30:tn=1,"
    "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.25:"
    "stop_periods=-1:stop_threshold=-50dB:stop_duration=1,"
    "dynaudnorm=f=200:g=11:p=0.9:m=15,apad=pad_dur=0.4"
)


class AudioError(ValueError):
    pass


def decode(data: bytes, filename: str | None = None, sample_rate: int = ASR_SAMPLE_RATE,
           clean: bool | None = None) -> np.ndarray:
    if not data:
        raise AudioError("The recording is empty.")
    clean = settings.denoise if clean is None else clean
    suffix = os.path.splitext(filename or "")[1] or ".bin"
    # A temp file, not a pipe: MP4/M4A keeps its index at the end and ffmpeg needs to seek.
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        path = tmp.name
    cmd = ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path]
    if clean:
        cmd += ["-af", CLEANUP]
    cmd += ["-f", "f32le", "-ac", "1", "-ar", str(sample_rate), "pipe:1"]
    try:
        proc = subprocess.run(cmd, capture_output=True, check=False)
    except FileNotFoundError as exc:
        raise AudioError("ffmpeg is not installed on the server.") from exc
    finally:
        os.unlink(path)
    if proc.returncode != 0:
        log.warning("ffmpeg failed: %s", proc.stderr.decode(errors="ignore")[-300:])
        raise AudioError("The recording couldn't be read. Try recording again.")
    samples = np.frombuffer(proc.stdout, dtype=np.float32)
    if samples.size < sample_rate * 0.3:
        raise AudioError("Nothing was heard. Hold the phone closer and speak again.")
    return samples


def to_wav(samples: np.ndarray, sample_rate: int) -> bytes:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm.tobytes())
    return buf.getvalue()


def median_pitch(samples: np.ndarray, sample_rate: int = ASR_SAMPLE_RATE) -> float | None:
    """Median voice pitch in Hz over voiced frames, or None when there isn't enough clear voice."""
    frame = int(0.04 * sample_rate)
    hop = frame // 2
    if samples.size < frame * 4:
        return None
    level = float(np.sqrt(np.mean(samples ** 2)))
    lo, hi = sample_rate // 400, sample_rate // 60  # search 60-400 Hz
    pitches: list[float] = []
    window = np.hanning(frame)
    for start in range(0, samples.size - frame, hop):
        x = samples[start:start + frame]
        if np.sqrt(np.mean(x ** 2)) < 0.5 * level:
            continue
        x = (x - x.mean()) * window
        spec = np.fft.rfft(x, n=2 * frame)
        ac = np.fft.irfft(spec * np.conj(spec))[:frame]
        if ac[0] <= 0:
            continue
        lag = lo + int(np.argmax(ac[lo:hi]))
        if ac[lag] / ac[0] > 0.3:
            pitches.append(sample_rate / lag)
    if len(pitches) < 5:
        return None
    return float(np.median(pitches))


def estimate_gender(samples: np.ndarray, sample_rate: int = ASR_SAMPLE_RATE) -> str | None:
    """Guess male/female from median voice pitch. Returns None when unsure; the app lets users correct it.

    Typical speaking pitch: men ~85-155 Hz, women ~165-255 Hz. Frames with little energy or no clear
    periodicity (consonants, noise) are skipped.
    """
    f0 = median_pitch(samples, sample_rate)
    if f0 is None:
        return None
    if f0 < 160:
        return "male"
    if f0 > 175:
        return "female"
    return None


# Typical speaking pitch to aim for when a single-voice engine has to sound male or female.
TARGET_PITCH = {"female": 205.0, "male": 112.0}


def shift_to_gender(samples: np.ndarray, sample_rate: int, gender: str) -> tuple[np.ndarray, bool]:
    """Moves a voice's pitch toward a typical male or female pitch, keeping its speed.

    Used when the server only has one voice for a language (MMS) and the user chose the other gender.
    It's an approximation (pitch and timbre move together), but clearly reads as the chosen gender.
    Returns (samples, changed)."""
    if gender not in TARGET_PITCH:
        return samples, False
    f0 = median_pitch(samples, sample_rate)
    if f0 is None or estimate_gender(samples, sample_rate) == gender:
        return samples, False
    factor = float(np.clip(TARGET_PITCH[gender] / f0, 0.65, 1.7))
    if abs(factor - 1) < 0.05:
        return samples, False
    # asetrate changes pitch and speed together; atempo puts the speed back (atempo takes 0.5-2.0).
    chain = f"asetrate={sample_rate * factor:.0f},aresample={sample_rate},atempo={1 / factor:.4f}"
    proc = subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "f32le", "-ar", str(sample_rate), "-ac", "1", "-i", "pipe:0",
         "-af", chain, "-f", "f32le", "-ar", str(sample_rate), "-ac", "1", "pipe:1"],
        input=np.ascontiguousarray(samples, dtype=np.float32).tobytes(), capture_output=True, check=False)
    if proc.returncode != 0 or not proc.stdout:
        log.warning("Pitch shift failed: %s", proc.stderr.decode(errors="ignore")[-200:])
        return samples, False
    return np.frombuffer(proc.stdout, dtype=np.float32).copy(), True
