"""Male/female voice: the choice reaches the speech engine, and a single-voice engine is shifted to match."""
from __future__ import annotations

import numpy as np
import pytest

from conftest import login

ASHA, RAHUL = "+919000000001", "+919000000002"  # Asha's profile voice is female, Rahul's male


@pytest.mark.parametrize("gender", ["female", "male"])
def test_get_tts_passes_the_chosen_gender(client, fake_ai, gender):
    asha = login(client, ASHA, "voice-test-01")
    r = client.get("/tts", params={"text": "hola", "language": "es-ES", "gender": gender}, headers=asha)
    assert r.status_code == 200 and r.headers["X-Voice-Gender"] == gender
    assert fake_ai.spoken[-1] == ("hola", "es-ES", gender)


@pytest.mark.parametrize("gender", ["female", "male"])
def test_post_tts_passes_the_chosen_gender(client, fake_ai, gender):
    rahul = login(client, RAHUL, "voice-test-02")
    r = client.post("/tts", json={"text": "hello", "language": "en-US", "gender": gender}, headers=rahul)
    assert r.status_code == 200 and fake_ai.spoken[-1][2] == gender


@pytest.mark.parametrize("phone,expected", [(ASHA, "female"), (RAHUL, "male")])
def test_without_a_choice_the_profile_voice_is_used(client, fake_ai, phone, expected):
    h = login(client, phone, "voice-test-03")
    client.get("/tts", params={"text": "hi", "language": "en-US"}, headers=h)
    assert fake_ai.spoken[-1][2] == expected


def test_profile_voice_change_is_used_next_time(client, fake_ai):
    asha = login(client, ASHA, "voice-test-04")
    client.patch("/me", json={"voice_gender": "male"}, headers=asha)
    client.get("/tts", params={"text": "hi", "language": "en-US"}, headers=asha)
    assert fake_ai.spoken[-1][2] == "male"


def test_invalid_gender_rejected(client):
    asha = login(client, ASHA, "voice-test-05")
    r = client.get("/tts", params={"text": "hi", "language": "en-US", "gender": "robot"}, headers=asha)
    assert r.status_code == 422


@pytest.mark.parametrize("choice", ["female", "male"])
def test_their_voice_toggle_reaches_the_translation(client, choice):
    asha = login(client, ASHA, "voice-test-06")
    r = client.post("/translate", json={"text": "I am tired", "source": "en-US", "target": "hi-IN",
                                       "speaker": "them", "speaker_gender": choice}, headers=asha)
    assert r.status_code == 200, r.text


def _voice(f0: float, sr: int = 16000, seconds: float = 1.5) -> np.ndarray:
    t = np.arange(int(sr * seconds)) / sr
    vibrato = 1 + 0.02 * np.sin(2 * np.pi * 5 * t)
    phase = 2 * np.pi * f0 * np.cumsum(vibrato) / sr
    wave = sum(np.sin(k * phase) / k for k in range(1, 8))
    return (0.2 * wave).astype(np.float32)


@pytest.mark.parametrize("start,want", [(118.0, "female"), (215.0, "male")])
def test_single_voice_is_shifted_to_the_chosen_gender(start, want):
    from app.audio import estimate_gender, shift_to_gender

    base = _voice(start)
    assert estimate_gender(base) != want
    shifted, changed = shift_to_gender(base, 16000, want)
    assert changed and estimate_gender(shifted) == want
    assert abs(len(shifted) - len(base)) < 0.05 * len(base)  # same speed


def test_voice_already_of_the_chosen_gender_is_left_alone():
    from app.audio import shift_to_gender

    base = _voice(118.0)
    out, changed = shift_to_gender(base, 16000, "male")
    assert not changed and out is base
