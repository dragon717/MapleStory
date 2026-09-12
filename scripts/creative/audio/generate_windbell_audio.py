#!/usr/bin/env python3
"""Generate the original Windbell Island / Bridge audio pack.

This is a deterministic local synthesizer, not model audio and not a copy of
any MapleStory recording.  It deliberately uses a few physical-ish additive
instruments (plucked string, wood/mallet, breathy woodwind, soft pad and
filtered noise) so the stems remain useful even without a soundfont.
"""

from __future__ import print_function

import json
import math
import shutil
import subprocess
import wave
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "resources" / "creative" / "windbell" / "audio"
SR = 44100
BPM = 96
BEATS_PER_BAR = 4
BARS = 32
BEAT = 60.0 / BPM
DURATION = BARS * BEATS_PER_BAR * BEAT
SAMPLES = int(round(DURATION * SR))
RNG = np.random.RandomState(27312)


def midi(note):
    return 440.0 * (2.0 ** ((float(note) - 69.0) / 12.0))


def pan_gains(pan):
    angle = (float(pan) + 1.0) * math.pi / 4.0
    return math.cos(angle), math.sin(angle)


def envelope(n, attack=0.01, decay=0.05, sustain=0.75, release=0.12):
    """ADSR with a release that always fits the requested event length."""
    if n <= 0:
        return np.zeros(0, dtype=np.float64)
    a = max(1, min(n, int(attack * SR)))
    d = max(1, min(max(1, n - a), int(decay * SR)))
    r = max(1, min(max(1, n - a - d), int(release * SR)))
    s = max(0, n - a - d - r)
    parts = [
        np.linspace(0.0, 1.0, a, endpoint=False),
        np.linspace(1.0, sustain, d, endpoint=False),
        np.full(s, sustain, dtype=np.float64),
        np.linspace(sustain, 0.0, r, endpoint=True),
    ]
    out = np.concatenate(parts)
    if len(out) < n:
        out = np.pad(out, (0, n - len(out)))
    return out[:n]


def lowpass_noise(n, cutoff=700.0, seed=0):
    """One-pole filtered noise, enough for breath, leaves and wood texture."""
    rng = np.random.RandomState(seed)
    raw = rng.normal(0.0, 1.0, n)
    alpha = min(0.98, max(0.002, 2.0 * math.pi * cutoff / SR))
    out = np.empty(n, dtype=np.float64)
    value = 0.0
    for i, sample in enumerate(raw):
        value += alpha * (sample - value)
        out[i] = value
    peak = np.max(np.abs(out)) or 1.0
    return out / peak


def tone(freq, seconds, kind="pluck", amp=0.2, pan=0.0, seed=0):
    n = max(1, int(round(seconds * SR)))
    t = np.arange(n, dtype=np.float64) / SR
    if kind == "pluck":
        partials = ((1.0, 1.0), (2.01, 0.34), (3.01, 0.18), (4.03, 0.09), (5.02, 0.04))
        y = sum(weight * np.sin(2.0 * math.pi * freq * ratio * t)
                for ratio, weight in partials)
        y += 0.035 * lowpass_noise(n, 2600.0, seed) * np.exp(-t * 34.0)
        env = envelope(n, 0.004, min(0.16, seconds * 0.32), 0.16, min(0.24, seconds * 0.3))
    elif kind == "wood":
        partials = ((1.0, 1.0), (2.0, 0.42), (3.98, 0.22), (5.1, 0.10), (7.2, 0.035))
        y = sum(weight * np.sin(2.0 * math.pi * freq * ratio * t + 0.12 * ratio)
                for ratio, weight in partials)
        y += 0.08 * lowpass_noise(n, 3600.0, seed) * np.exp(-t * 55.0)
        env = envelope(n, 0.002, min(0.12, seconds * 0.3), 0.12, min(0.18, seconds * 0.25))
    elif kind == "mallet":
        partials = ((1.0, 1.0, 3.0), (2.0, 0.46, 6.5), (3.98, 0.24, 9.0), (5.2, 0.10, 12.0))
        y = sum(weight * np.sin(2.0 * math.pi * freq * ratio * t) * np.exp(-t * decay)
                for ratio, weight, decay in partials)
        y += 0.025 * lowpass_noise(n, 5000.0, seed) * np.exp(-t * 90.0)
        env = envelope(n, 0.001, 0.04, 0.15, min(0.18, seconds * 0.25))
    elif kind == "woodwind":
        vibrato = 1.0 + 0.0032 * np.sin(2.0 * math.pi * 5.1 * t)
        phase = 2.0 * math.pi * freq * np.cumsum(vibrato) / SR
        y = (np.sin(phase) + 0.52 * np.sin(2.0 * phase) +
             0.28 * np.sin(3.0 * phase) + 0.14 * np.sin(4.0 * phase) +
             0.07 * np.sin(5.0 * phase))
        y += 0.035 * lowpass_noise(n, 1800.0, seed)
        env = envelope(n, min(0.16, seconds * 0.2), min(0.14, seconds * 0.2), 0.74,
                       min(0.24, seconds * 0.2))
    elif kind == "bass":
        y = (np.sin(2.0 * math.pi * freq * t) +
             0.22 * np.sin(2.0 * math.pi * 2.0 * freq * t) +
             0.08 * np.sin(2.0 * math.pi * 3.0 * freq * t))
        env = envelope(n, 0.008, 0.10, 0.45, min(0.20, seconds * 0.25))
    elif kind == "pad":
        y = (np.sin(2.0 * math.pi * freq * t) +
             0.36 * np.sin(2.0 * math.pi * 2.0 * freq * t + 0.4) +
             0.16 * np.sin(2.0 * math.pi * 3.0 * freq * t + 1.1))
        y += 0.035 * lowpass_noise(n, 320.0, seed)
        env = envelope(n, min(0.35, seconds * 0.3), min(0.35, seconds * 0.25), 0.52,
                       min(0.45, seconds * 0.25))
    else:
        raise ValueError("unknown tone kind: %s" % kind)
    y = y * env * float(amp)
    left, right = pan_gains(pan)
    return np.column_stack((y * left, y * right))


def add_event(stem, beat, seconds, note, kind, amp, pan=0.0, seed=0):
    start = int(round(beat * BEAT * SR))
    if start >= len(stem):
        return
    clip = tone(midi(note), seconds, kind, amp, pan, seed)
    end = min(len(stem), start + len(clip))
    stem[start:end] += clip[:end - start]


def add_chord(stem, beat, bars, notes, amp, pan_spread=0.35, seed=0):
    seconds = bars * BEATS_PER_BAR * BEAT + 0.25
    for i, note in enumerate(notes):
        pan = ((i / max(1, len(notes) - 1)) * 2.0 - 1.0) * pan_spread
        stem_part = tone(midi(note), seconds, "pad", amp, pan, seed + i)
        start = int(round(beat * BEAT * SR))
        end = min(len(stem), start + len(stem_part))
        if start < end:
            stem[start:end] += stem_part[:end - start]


def bar_beat(bar, beat=0.0):
    return bar * BEATS_PER_BAR + beat


def motif_events(stem, start_bar, amp=0.12, octave=0, kind="pluck", pan=0.0, seed=0):
    # The six-note seed is original to this pack; all later parts are derived
    # from this interval shape rather than an existing game melody.
    notes = [62 + octave, 66 + octave, 69 + octave, 71 + octave, 67 + octave, 64 + octave]
    lengths = [0.5, 0.5, 1.0, 0.5, 0.5, 1.0]
    cursor = 0.0
    for i, (note, length) in enumerate(zip(notes, lengths)):
        add_event(stem, bar_beat(start_bar, cursor), length * 0.88, note, kind,
                  amp * (1.0 if i < 3 else 0.88), pan + 0.08 * math.sin(i), seed + i)
        cursor += length


def wind_bed(seconds, seed=0, amp=0.018):
    n = int(round(seconds * SR))
    slow = lowpass_noise(n, 1.3, seed)
    mid = lowpass_noise(n, 170.0, seed + 1)
    motion = 0.72 + 0.28 * np.sin(2.0 * math.pi * np.arange(n) / SR / 11.0)
    y = (0.64 * slow + 0.36 * mid) * motion * amp
    pan = np.sin(2.0 * math.pi * np.arange(n) / SR / 17.0)
    return np.column_stack((y * (0.72 - 0.12 * pan), y * (0.72 + 0.12 * pan)))


def make_island_stems():
    stems = [np.zeros((SAMPLES, 2), dtype=np.float64) for _ in range(4)]
    base, motion, height, discovery = stems
    base[:] += wind_bed(DURATION, 1127, 0.022)
    chords = [[38, 45, 50, 54], [35, 42, 47, 50], [43, 50, 55, 59], [45, 52, 57, 61]]
    for repetition in range(4):
        offset = repetition * 8
        for chord_i, chord in enumerate(chords):
            add_chord(base, bar_beat(offset + chord_i * 2), 2.2, chord, 0.050, 0.30,
                      100 + repetition * 12 + chord_i)
        for bar in range(offset, offset + 8):
            pattern = [50, 57, 54, 57, 52, 57, 54, 57]
            for i, note in enumerate(pattern):
                add_event(base, bar_beat(bar, i * 0.5), 0.34, note, "pluck", 0.050,
                          -0.22 + i * 0.06, 2000 + bar * 8 + i)
        motif_events(base, offset + 1, 0.078, 0, "pluck", -0.06, 2300 + repetition)

    # M2: an even, gentle travel pulse; it is continuous by phrase, not by
    # every footstep, so the game can fade it with a 1–2 second hysteresis.
    for bar in range(BARS):
        for i, note in enumerate([38, 45, 42, 45, 40, 45, 42, 45]):
            add_event(motion, bar_beat(bar, i * 0.5), 0.22, note, "wood", 0.072,
                      0.15 if i % 2 else -0.15, 3000 + bar * 8 + i)
        if bar % 2 == 0:
            add_event(motion, bar_beat(bar, 0), 0.46, 26, "bass", 0.105, -0.05, 3400 + bar)
            add_event(motion, bar_beat(bar, 2), 0.40, 31, "bass", 0.078, 0.05, 3500 + bar)

    # M3: high canopy and sky-open counterline.
    high_phrase = [74, 76, 78, 81, 79, 76, 74, 71]
    for repetition in range(4):
        offset = repetition * 8
        for i, note in enumerate(high_phrase):
            add_event(height, bar_beat(offset + 1, i * 0.5), 0.42, note, "woodwind", 0.11,
                      -0.16 + 0.045 * i, 4000 + repetition * 32 + i)
        for bar in [offset + 3, offset + 7]:
            add_event(height, bar_beat(bar, 0.0), 1.3, 62, "woodwind", 0.075, 0.20, 4200 + bar)
            add_event(height, bar_beat(bar, 2.0), 1.1, 66, "woodwind", 0.062, -0.18, 4300 + bar)
        add_chord(height, bar_beat(offset), 8.1, [62, 66, 69], 0.018, 0.42, 4400 + repetition)

    # M4: sparse discovery answer that can fade in after discovery_fact.
    for repetition in range(4):
        offset = repetition * 8
        for bar, notes in [(offset + 0, [74, 78]), (offset + 4, [76, 81])]:
            for i, note in enumerate(notes):
                add_event(discovery, bar_beat(bar, 1.0 + i * 0.5), 0.72, note, "mallet", 0.095,
                          -0.22 + 0.44 * i, 5000 + repetition * 12 + bar + i)
        motif_events(discovery, offset + 6, 0.052, 1, "mallet", 0.10, 5100 + repetition)
    return stems


def make_bridge_stems():
    stems = [np.zeros((SAMPLES, 2), dtype=np.float64) for _ in range(4)]
    base, construction, transport, arrival = stems
    base[:] += wind_bed(DURATION, 6127, 0.027)
    chords = [[40, 47, 52, 56], [37, 44, 49, 52], [45, 52, 57, 61], [47, 54, 59, 63]]
    for repetition in range(4):
        offset = repetition * 8
        for chord_i, chord in enumerate(chords):
            add_chord(base, bar_beat(offset + chord_i * 2), 2.2, chord, 0.052, 0.28,
                      6100 + repetition * 12 + chord_i)
        for bar in range(offset, offset + 8):
            for i, note in enumerate([52, 59, 56, 59, 54, 59, 56, 59]):
                add_event(base, bar_beat(bar, i * 0.5), 0.31, note, "pluck", 0.045,
                          -0.18 + i * 0.05, 6200 + bar * 8 + i)
        motif_events(base, offset + 2, 0.070, -1, "pluck", 0.05, 6300 + repetition)

    # M2: wood-and-rope work pulse; a clear place to fade in while a job runs.
    for bar in range(BARS):
        for i, note in enumerate([45, 52, 49, 52, 47, 52, 49, 52]):
            add_event(construction, bar_beat(bar, i * 0.5), 0.24, note, "wood", 0.078,
                      -0.10 if i % 2 else 0.11, 6400 + bar * 8 + i)
        if bar % 2 == 1:
            add_event(construction, bar_beat(bar, 1.5), 0.35, 33, "bass", 0.078, 0.0, 6500 + bar)

    # M3: the transport line opens as the bridge becomes useful to a real cart.
    phrase = [69, 71, 73, 76, 74, 71, 69, 66]
    for repetition in range(4):
        offset = repetition * 8
        for i, note in enumerate(phrase):
            add_event(transport, bar_beat(offset + 1, i * 0.5), 0.44, note, "woodwind", 0.102,
                      -0.18 + i * 0.045, 6600 + repetition * 32 + i)
        for bar in [offset + 4, offset + 7]:
            add_event(transport, bar_beat(bar, 0), 1.15, 57, "woodwind", 0.062, 0.18, 6700 + bar)
            add_event(transport, bar_beat(bar, 2), 1.0, 61, "woodwind", 0.052, -0.16, 6800 + bar)
        add_chord(transport, bar_beat(offset), 8.1, [64, 68, 71], 0.016, 0.40, 6900 + repetition)

    # M4: short bell-like civic memory / arrival response, sparse enough for NPC speech.
    for repetition in range(4):
        offset = repetition * 8
        for bar, notes in [(offset + 1, [76, 80]), (offset + 5, [78, 83])]:
            for i, note in enumerate(notes):
                add_event(arrival, bar_beat(bar, 1.0 + i * 0.5), 0.70, note, "mallet", 0.087,
                          -0.20 + 0.40 * i, 7000 + repetition * 12 + bar + i)
        motif_events(arrival, offset + 6, 0.048, 1, "mallet", -0.04, 7100 + repetition)
    return stems


def hit(stem, start, y):
    start = int(round(start * SR))
    end = min(len(stem), start + len(y))
    if start < end:
        stem[start:end] += y[:end - start]


def sfx_tone(freq, length, amp, kind="wood", pan=0.0, seed=0):
    return tone(freq, length, kind, amp, pan, seed)


def noise_burst(length, amp=0.2, cutoff=1600.0, seed=0, pan=0.0):
    n = max(1, int(round(length * SR)))
    t = np.arange(n, dtype=np.float64) / SR
    y = lowpass_noise(n, cutoff, seed) * np.exp(-t * (4.0 / max(0.04, length))) * amp
    left, right = pan_gains(pan)
    return np.column_stack((y * left, y * right))


def make_sfx(name):
    """Return a short stereo effect with the event's causal character."""
    if name == "step_grass":
        out = noise_burst(0.16, 0.17, 1100, 8001, -0.20)
        hit(out, 0.025, sfx_tone(150, 0.12, 0.055, "bass", 0.0, 8002))
        return out
    if name == "step_wood":
        return sfx_tone(190, 0.20, 0.17, "wood", -0.10, 8010)
    if name == "step_stone":
        out = sfx_tone(235, 0.18, 0.15, "wood", 0.10, 8020)
        hit(out, 0.0, noise_burst(0.08, 0.055, 3400, 8021, 0.0))
        return out
    if name == "jump_land":
        out = sfx_tone(100, 0.34, 0.25, "bass", 0.0, 8030)
        hit(out, 0.0, noise_burst(0.10, 0.10, 2400, 8031, 0.0))
        return out
    if name == "cut_rope":
        out = noise_burst(0.31, 0.23, 3100, 8040, -0.12)
        hit(out, 0.03, sfx_tone(820, 0.18, 0.12, "pluck", 0.12, 8041))
        return out
    if name == "rope_sever":
        out = sfx_tone(118, 0.82, 0.22, "bass", -0.08, 8050)
        hit(out, 0.02, noise_burst(0.40, 0.21, 1800, 8051, 0.0))
        hit(out, 0.34, sfx_tone(330, 0.30, 0.13, "wood", 0.12, 8052))
        return out
    if name == "bridge_land":
        out = sfx_tone(74, 1.22, 0.31, "bass", 0.0, 8060)
        hit(out, 0.02, noise_burst(0.75, 0.19, 900, 8061, -0.18))
        hit(out, 0.38, sfx_tone(136, 0.70, 0.16, "wood", 0.18, 8062))
        return out
    if name == "cart_wood_support":
        out = sfx_tone(175, 0.62, 0.20, "wood", -0.15, 8070)
        hit(out, 0.14, noise_burst(0.24, 0.09, 1900, 8071, 0.18))
        return out
    if name == "material_handoff":
        out = sfx_tone(440, 0.26, 0.13, "wood", -0.20, 8080)
        hit(out, 0.16, sfx_tone(554, 0.30, 0.11, "mallet", 0.18, 8081))
        return out
    if name == "craftsman_install":
        out = sfx_tone(210, 0.70, 0.18, "wood", -0.14, 8090)
        hit(out, 0.24, noise_burst(0.22, 0.07, 2800, 8091, 0.14))
        hit(out, 0.46, sfx_tone(290, 0.32, 0.10, "wood", 0.08, 8092))
        return out
    if name == "cart_wheels":
        n = int(round(1.45 * SR))
        t = np.arange(n, dtype=np.float64) / SR
        rattle = lowpass_noise(n, 1450, 8100) * (0.05 + 0.025 * np.sin(2 * math.pi * 4.0 * t))
        y = rattle + 0.07 * np.sin(2 * math.pi * 96 * t) + 0.025 * np.sin(2 * math.pi * 192 * t)
        env = envelope(n, 0.04, 0.12, 0.60, 0.20)
        y *= env
        return np.column_stack((y * 0.92, y * 0.74))
    if name == "arrival":
        out = sfx_tone(392, 0.34, 0.15, "mallet", -0.16, 8110)
        hit(out, 0.16, sfx_tone(523, 0.52, 0.13, "mallet", 0.16, 8111))
        hit(out, 0.32, sfx_tone(659, 0.72, 0.10, "mallet", 0.0, 8112))
        return out
    if name == "heat_damp":
        out = noise_burst(0.92, 0.15, 720, 8120, 0.12)
        hit(out, 0.16, noise_burst(0.52, 0.09, 3300, 8121, -0.10))
        hit(out, 0.55, sfx_tone(840, 0.30, 0.07, "woodwind", 0.08, 8122))
        return out
    if name == "fire_ignite":
        out = noise_burst(0.58, 0.15, 2100, 8130, 0.0)
        hit(out, 0.12, sfx_tone(248, 0.48, 0.13, "wood", -0.12, 8131))
        hit(out, 0.23, sfx_tone(496, 0.38, 0.07, "mallet", 0.12, 8132))
        return out
    if name == "fire_loop":
        n = int(round(2.2 * SR))
        y = lowpass_noise(n, 2300, 8140) * 0.09
        t = np.arange(n) / float(SR)
        y += 0.025 * np.sin(2 * math.pi * 82 * t) * (0.7 + 0.3 * np.sin(2 * math.pi * 2.3 * t))
        y *= envelope(n, 0.15, 0.18, 0.72, 0.25)
        return np.column_stack((y * 0.85, y * 0.72))
    if name == "fire_extinguish":
        out = noise_burst(0.80, 0.13, 900, 8150, -0.10)
        hit(out, 0.08, noise_burst(0.52, 0.07, 2600, 8151, 0.10))
        return out
    if name == "wing_open":
        n = int(round(0.78 * SR))
        y = lowpass_noise(n, 1800, 8160) * np.linspace(0.03, 0.16, n)
        t = np.arange(n) / float(SR)
        y += 0.035 * np.sin(2 * math.pi * 210 * t) * np.sin(math.pi * t / 0.78)
        return np.column_stack((y * 0.64, y * 0.96))
    if name == "wing_close":
        n = int(round(0.56 * SR))
        y = lowpass_noise(n, 1500, 8170) * np.linspace(0.14, 0.02, n)
        y += 0.024 * np.sin(2 * math.pi * 160 * np.arange(n) / SR)
        y *= envelope(n, 0.02, 0.08, 0.50, 0.15)
        return np.column_stack((y * 0.90, y * 0.68))
    if name == "updraft":
        n = int(round(1.72 * SR))
        t = np.arange(n, dtype=np.float64) / SR
        y = lowpass_noise(n, 520, 8180) * (0.045 + 0.055 * t / 1.72)
        y += 0.028 * np.sin(2 * math.pi * 72 * t + 0.4 * np.sin(2 * math.pi * 0.7 * t))
        return np.column_stack((y * 0.68, y * 0.90))
    if name == "dragon_wing":
        n = int(round(2.35 * SR))
        t = np.arange(n, dtype=np.float64) / SR
        pulse = 0.50 + 0.50 * np.sin(2 * math.pi * 0.85 * t - 1.0)
        y = lowpass_noise(n, 390, 8190) * 0.11 * pulse
        y += 0.045 * np.sin(2 * math.pi * 48 * t) * pulse
        y *= envelope(n, 0.30, 0.25, 0.65, 0.40)
        return np.column_stack((y * 0.72, y * 0.72))
    if name == "bell":
        out = sfx_tone(784, 1.55, 0.13, "mallet", 0.0, 8200)
        hit(out, 0.0, sfx_tone(1175, 1.08, 0.06, "mallet", 0.08, 8201))
        return out
    if name == "creature":
        out = sfx_tone(620, 0.20, 0.10, "woodwind", -0.14, 8210)
        hit(out, 0.15, sfx_tone(740, 0.24, 0.085, "woodwind", 0.13, 8211))
        return out
    if name == "npc_hint":
        out = sfx_tone(523, 0.20, 0.085, "mallet", -0.08, 8220)
        hit(out, 0.12, sfx_tone(659, 0.30, 0.065, "mallet", 0.08, 8221))
        return out
    if name == "discover":
        out = sfx_tone(587, 0.28, 0.11, "mallet", -0.18, 8230)
        hit(out, 0.18, sfx_tone(784, 0.44, 0.10, "mallet", 0.16, 8231))
        hit(out, 0.40, sfx_tone(988, 0.72, 0.078, "mallet", 0.0, 8232))
        return out
    raise ValueError("unknown SFX: %s" % name)


def loop_safe(stem, fade_seconds=0.08):
    """Close the exact loop seam without changing its sample count."""
    n = min(len(stem) // 2, int(round(fade_seconds * SR)))
    if n <= 0:
        return stem
    a = np.linspace(0.0, 1.0, n, endpoint=True)[:, None]
    edge = (stem[-1:] + stem[:1]) * 0.5
    stem[-n:] = stem[-n:] * (1.0 - a) + edge * a
    stem[:n] = edge * (1.0 - a) + stem[:n] * a
    return stem


def normalise(audio, peak=0.72):
    maximum = float(np.max(np.abs(audio))) if audio.size else 0.0
    if maximum > peak:
        audio = audio * (peak / maximum)
    return np.tanh(audio * 1.06) / np.tanh(1.06)


def write_wav(path, audio):
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(audio, -1.0, 1.0)
    pcm = np.asarray(np.round(pcm * 32767.0), dtype=np.int16)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(SR)
        handle.writeframes(pcm.tobytes())


def to_ogg(wav_path):
    ogg_path = wav_path.with_suffix(".ogg")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to make the web OGG files")
    # This ffmpeg build exposes the native encoder as `vorbis`; avoid relying
    # on the optional libvorbis wrapper so the pack rebuilds on this machine.
    subprocess.check_call([ffmpeg, "-y", "-loglevel", "error", "-i", str(wav_path),
                           "-c:a", "vorbis", "-strict", "experimental", "-q:a", "5",
                           str(ogg_path)])
    return ogg_path


def dbfs(audio):
    rms = float(np.sqrt(np.mean(np.square(audio)))) if audio.size else 0.0
    return 20.0 * math.log10(max(rms, 1e-12))


def peak_dbfs(audio):
    return 20.0 * math.log10(max(float(np.max(np.abs(audio))), 1e-12))


def metrics(path, expected_seconds=None, loop=False):
    with wave.open(str(path), "rb") as handle:
        channels = handle.getnchannels()
        sample_rate = handle.getframerate()
        frames = handle.getnframes()
        data = np.frombuffer(handle.readframes(frames), dtype=np.int16).astype(np.float64) / 32767.0
    if channels > 1:
        audio = data.reshape((-1, channels))
    else:
        audio = data[:, None]
    seam = float(np.max(np.abs(audio[0] - audio[-1]))) if len(audio) else 0.0
    boundary_rms = float(np.sqrt(np.mean(np.square(audio[:min(2048, len(audio))] -
                                                   audio[-min(2048, len(audio)):])))) if len(audio) >= 2 else 0.0
    result = {
        "path": str(path.relative_to(ROOT)),
        "sample_rate_hz": sample_rate,
        "channels": channels,
        "samples": frames,
        "duration_seconds": round(frames / float(sample_rate), 6),
        "peak_dbfs": round(peak_dbfs(audio), 3),
        "rms_dbfs": round(dbfs(audio), 3),
        "non_silent_fraction": round(float(np.mean(np.max(np.abs(audio), axis=1) > 0.0005)), 5),
    }
    if expected_seconds is not None:
        result["expected_seconds"] = expected_seconds
        result["duration_exact"] = abs(result["duration_seconds"] - expected_seconds) < (1.0 / sample_rate)
    if loop:
        result["loop_boundary_peak_delta"] = round(seam, 7)
        result["loop_boundary_rms_delta"] = round(boundary_rms, 7)
        # The only hard seam is the last-sample → first-sample jump. The
        # window metric is diagnostic because musical phrases do not need to
        # be mirror images at the loop boundary.
        result["loop_boundary_ok"] = seam < 0.03
    return result


def save_music(scene, stems, names):
    scene_dir = OUT / scene
    scene_dir.mkdir(parents=True, exist_ok=True)
    wav_paths = []
    for stem, name in zip(stems, names):
        stem = normalise(loop_safe(stem))
        path = scene_dir / (name + ".wav")
        write_wav(path, stem)
        to_ogg(path)
        wav_paths.append(path)
    mix = normalise(np.sum([np.asarray(s) for s in stems], axis=0), 0.87)
    mix = loop_safe(mix)
    mix = normalise(mix, 0.87)
    mix_path = scene_dir / (scene + "_mix.wav")
    write_wav(mix_path, mix)
    to_ogg(mix_path)
    return wav_paths + [mix_path]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    island_names = ["island_m1_forest_floor", "island_m2_travel", "island_m3_high_canopy",
                    "island_m4_discovery"]
    bridge_names = ["bridge_m1_base", "bridge_m2_construction", "bridge_m3_transport",
                    "bridge_m4_arrival"]
    island_stems = make_island_stems()
    bridge_stems = make_bridge_stems()
    music_paths = save_music("island", island_stems, island_names)
    music_paths += save_music("bridge", bridge_stems, bridge_names)

    sfx_names = [
        "step_grass", "step_wood", "step_stone", "jump_land", "cut_rope", "rope_sever",
        "bridge_land", "cart_wood_support", "material_handoff", "craftsman_install",
        "cart_wheels", "arrival", "heat_damp", "fire_ignite", "fire_loop",
        "fire_extinguish", "wing_open", "wing_close", "updraft", "dragon_wing", "bell",
        "creature", "npc_hint", "discover",
    ]
    sfx_dir = OUT / "sfx"
    sfx_dir.mkdir(parents=True, exist_ok=True)
    sfx_paths = []
    for i, name in enumerate(sfx_names):
        audio = normalise(make_sfx(name), 0.70)
        path = sfx_dir / (name + ".wav")
        write_wav(path, audio)
        to_ogg(path)
        sfx_paths.append(path)

    composition = {
        "origin": "Original deterministic programmatic composition and synthesis; no model audio and no copied MapleStory melody.",
        "tempo_bpm": BPM,
        "meter": "4/4",
        "bars": BARS,
        "duration_seconds": DURATION,
        "sample_rate_hz": SR,
        "island": {
            "title": "风从树梢来 / Wind Through the Canopy",
            "layers": {
                "M1": "林下 / forest floor: pad, plucked string, filtered leaf-wind bed",
                "M2": "行进 / travel: soft wood pulse and low movement notes",
                "M3": "高处 / high canopy: breathy woodwind counterline and open chord color",
                "M4": "发现 / discovery: sparse mallet answer, fades in after discovery_fact",
            },
            "motif_notes_midi": [62, 66, 69, 71, 67, 64],
            "chord_cycle_midi": [[38, 45, 50, 54], [35, 42, 47, 50], [43, 50, 55, 59], [45, 52, 57, 61]],
        },
        "bridge": {
            "title": "桥上有风 / Wind Across the Bridge",
            "layers": {
                "M1": "基础 / base: public-place pad, plucked wood and river wind",
                "M2": "施工 / construction: steady mallet/wood work pulse",
                "M3": "运输 / transport: open woodwind line when a real cart can travel",
                "M4": "到货 / arrival: sparse civic memory / arrival answer",
            },
            "motif_notes_midi": [62, 66, 69, 71, 67, 64],
            "chord_cycle_midi": [[40, 47, 52, 56], [37, 44, 49, 52], [45, 52, 57, 61], [47, 54, 59, 63]],
        },
        "sfx": sfx_names,
    }
    composition_path = OUT / "composition.json"
    composition_path.write_text(json.dumps(composition, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    all_paths = music_paths + sfx_paths
    validation = {
        "generated_by": str(Path(__file__).resolve().relative_to(ROOT)),
        "origin": composition["origin"],
        "loop_spec": {"bars": BARS, "bpm": BPM, "seconds": DURATION, "samples": SAMPLES,
                       "stems_same_start_and_length": True},
        "files": [],
    }
    for path in all_paths:
        validation["files"].append(metrics(path, DURATION if path.parent.name in ("island", "bridge") else None,
                                             path.parent.name in ("island", "bridge")))
    validation_path = OUT / "validation.json"
    validation_path.write_text(json.dumps(validation, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    bad = [item for item in validation["files"] if item.get("duration_exact") is False or
           item.get("loop_boundary_ok") is False]
    if bad:
        raise SystemExit("audio validation failed: %s" % bad)
    print(json.dumps({"music_files": len(music_paths), "sfx_files": len(sfx_paths),
                      "validation": str(validation_path.relative_to(ROOT))}, ensure_ascii=False))


if __name__ == "__main__":
    main()
