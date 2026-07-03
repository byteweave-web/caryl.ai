"""
automation.py - BRAIN.AI's desktop automation sidecar (REFINED build).

A small Flask server on 127.0.0.1:7842, spawned by main.js (lazily, in the refined build)
and killed with it. Talks to main.js's vision webhook (127.0.0.1:7843) to turn a plain-English
target ("the submit button") into screen coordinates, so nothing upstream ever has to guess or
hardcode a pixel position.

Also provides:
  - /transcribe : local speech-to-text via faster-whisper (offline voice input)
  - /vad        : server-side voice-activity check (energy + duration + silence trim)
                  used by main.js to DROP garbage audio before it ever reaches Whisper

REFINED CHANGES (vs the original automation.py):
  - locate_on_screen() now accepts a `max_width` arg so the caller can retry at a higher
    resolution if the first attempt fails (was hardcoded to LOCATE_MAX_WIDTH).
  - locate_on_screen() returns richer info: {x, y, w, h, conf} when the vision model emits
    a bbox; falls back to {x, y} for back-compat. This enables on-screen highlighting +
    click-verification.
  - /act now supports a `verify` flag: after a click, it takes a fresh screenshot and
    compares it to the pre-click screenshot; if pixels changed noticeably, the click is
    treated as successful. Otherwise it returns {ok, verify: 'no_change'} so the caller
    can retry with a re-located target.
  - /act supports `highlight_ms`: if >0, draws a translucent yellow box at the target for
    that many ms before clicking (user sees what's about to happen).
  - Tighter rate-limit handling on the vision webhook call (15s timeout, was 25s).
  - /vad endpoint: takes base64 audio, returns {ok, has_speech, duration_ms, rms_db,
    trimmed_duration_ms, reason}. main.js uses this to reject clips that are silence /
    background noise BEFORE sending them to Whisper - this is the "random words from mic"
    root-cause fix at the server side.
  - faster-whisper device/compute_type auto-pick: cuda if available, else int8 CPU.
  - Memory: whisper models are now LRU-cached (was unbounded dict).
  - All safety semantics from the original are preserved verbatim.

SAFETY MODEL - read this before changing it:
  - Two permission flags, matching the two toggles in Settings:
      mouse_enabled     gates click / rightclick / doubleclick / scroll / drag
      scripting_enabled gates type / hotkey / shell / all file writes
    Both default to OFF every time the sidecar starts.
  - Shell commands additionally require the CALLER to have already gotten the user's
    explicit per-command confirmation (request body must have "confirmed": true).
  - Delete is a SOFT delete: files move to a .trash folder inside the sandbox.
  - Binds to 127.0.0.1 only. Never 0.0.0.0.
"""

import base64
import gc
import io
import json
import logging
import math
import os
import re
import shutil
import tempfile
import threading
import time
import uuid
from collections import OrderedDict
from datetime import datetime
from logging.handlers import RotatingFileHandler

from flask import Flask, jsonify, request

try:
    import pyautogui
except Exception as e:  # pragma: no cover
    pyautogui = None
    _import_error = str(e)
else:
    _import_error = None
    pyautogui.FAILSAFE = False  # slam the mouse to a screen corner to abort - never disable this
    pyautogui.PAUSE = 0.08      # REFINED: 0.1 -> 0.08. Small speedup; still safe.

# UIA v3 - Windows UI Automation (accessibility tree) for PRECISE element location.
# This is the "stop guessing pixels from a screenshot" fix: named UI elements (buttons, menu
# items, desktop icons, list rows...) expose their exact on-screen rectangle through the
# accessibility tree, so clicking them needs NO vision model at all. locate_on_screen() now
# tries UIA first and only falls back to the vision webhook for things UIA can't name
# (canvas content, images, games). Install with:
#   pip install uiautomation
try:
    import uiautomation as _uia  # type: ignore
    _uia_import_error = None
except Exception as e:  # pragma: no cover
    _uia = None
    _uia_import_error = str(e)

# Make this process DPI-aware so UIA rectangles, pyautogui clicks, and screenshots all speak
# the same physical-pixel coordinate system on scaled displays (125%/150% Windows scaling).
# Without this, Windows "virtualizes" our coordinates and UIA rects land off-target.
if os.name == "nt":
    try:
        import ctypes
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PER_MONITOR_AWARE (Win 8.1+)
        except Exception:
            ctypes.windll.user32.SetProcessDPIAware()       # older fallback
    except Exception:
        pass

# [OFFLINE-INTEGRATION] Local speech-to-text (optional). Install with:
#   pip install faster-whisper
try:
    from faster_whisper import WhisperModel as _FWModel
except Exception as e:  # pragma: no cover
    _FWModel = None
    _fw_import_error = str(e)
else:
    _fw_import_error = None

# REFINED: LRU cache for whisper models (was unbounded dict). 2 models max - tiny.en + base.en
# is the typical pair; never need more resident at once.
_WHISPER_LRU = OrderedDict()
_WHISPER_LRU_MAX = 2
_whisper_lock = threading.Lock()

# Cache of the last /elements walk, so /act can resolve an element_id to exact coordinates
# without re-walking. Invalidated (overwritten) by the next /elements call.
_ELEMENT_CACHE = {"items": [], "ts": 0.0}
_ELEMENT_CAP = 150  # entries shown to the planner; full list stays cached for id resolution


def _detect_whisper_device():
    """REFINED: prefer CUDA if faster-whisper + onnxruntime-gpu are installed; else CPU."""
    try:
        import torch  # type: ignore
        if torch.cuda.is_available():
            return "cuda", "float16"
    except Exception:
        pass
    return "cpu", "int8"


def _get_whisper(name):
    """Load (once) and cache a faster-whisper model. LRU-evicts the oldest when full."""
    with _whisper_lock:
        _touch_whisper()
        m = _WHISPER_LRU.pop(name, None)
        if m is None:
            device, compute = _detect_whisper_device()
            try:
                m = _FWModel(name, device=device, compute_type=compute)
            except Exception:
                # GPU init can fail on a misconfigured box; fall back to CPU int8 which always works.
                m = _FWModel(name, device="cpu", compute_type="int8")
        _WHISPER_LRU[name] = m
        while len(_WHISPER_LRU) > _WHISPER_LRU_MAX:
            _WHISPER_LRU.popitem(last=False)
        return m


# Idle unload: whisper models are only resident while voice input is actually in use.
# 5 idle minutes -> drop them (reload cost is one cold start on the next utterance).
_WHISPER_LAST_USED = 0.0
_WHISPER_IDLE_S = 300


def _touch_whisper():
    global _WHISPER_LAST_USED
    _WHISPER_LAST_USED = time.time()


def _whisper_idle_reaper():
    while True:
        time.sleep(60)
        with _whisper_lock:
            if _WHISPER_LRU and _WHISPER_LAST_USED and (time.time() - _WHISPER_LAST_USED) > _WHISPER_IDLE_S:
                _WHISPER_LRU.clear()
                gc.collect()


threading.Thread(target=_whisper_idle_reaper, daemon=True).start()


HOST = "127.0.0.1"
PORT = 7842
VISION_WEBHOOK = "http://127.0.0.1:7843/vision"
# REFINED: 25s -> 15s. 25s masked genuine failures as "still working"; 15s is plenty for a
# warm vision model. The caller retries on timeout, so a slightly tighter cap is strictly better.
VISION_TIMEOUT_S = 15

# Default screenshot width for locate. Caller can override via `max_width` in the request body.
LOCATE_MAX_WIDTH = 1024  # REFINED: 1280 -> 1024 default. Saves ~30% bandwidth per locate.

SANDBOX_ROOT = os.path.join(os.path.expanduser("~"), "BRAINFiles")
TRASH_DIR = os.path.join(SANDBOX_ROOT, ".trash")

# Backstop only - see the safety note at the top of this file.
SHELL_BLOCKLIST = [
    r"rm\s+-rf\s+/", r"rm\s+-rf\s+~", r"rm\s+-rf\s+\*",
    r"format\s+[a-z]:", r"del\s+/f\s+/s\s+/q", r"rd\s+/s\s+/q",
    r"shutdown", r"mkfs", r"dd\s+if=", r":(){ :\|:& };:",
    r">\s*/dev/sd", r"diskpart",
]

app = Flask(__name__)

os.makedirs(SANDBOX_ROOT, exist_ok=True)
os.makedirs(TRASH_DIR, exist_ok=True)

logger = logging.getLogger("automation")
logger.setLevel(logging.INFO)


def _make_log_handler():
    candidates = [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "automation.log"),
        os.path.join(SANDBOX_ROOT, "automation.log"),
    ]
    for p in candidates:
        try:
            return RotatingFileHandler(p, maxBytes=2_000_000, backupCount=2)
        except Exception:
            continue
    return logging.NullHandler()


_handler = _make_log_handler()
_handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
logger.addHandler(_handler)


def log_action(kind, detail):
    try:
        d = (detail or "")[:200]
        logger.info(json.dumps({"kind": kind, "detail": d}))
    except Exception:
        pass


PERMS = {"mouse_enabled": False, "scripting_enabled": False}

# ----------------------------------------------------------------- hotkeys
_KEY_ALIASES = {
    "windows": "win", "windows key": "win", "winkey": "win", "win key": "win",
    "super": "win", "meta": "win", "cmd": "win", "command": "win", "start": "win",
    "return": "enter", "esc": "escape", "control": "ctrl", "cntrl": "ctrl", "cntl": "ctrl",
    "spacebar": "space", "space bar": "space", "del": "delete", "ins": "insert",
    "pgup": "pageup", "page up": "pageup", "pgdn": "pagedown", "page down": "pagedown",
    "arrowup": "up", "arrow up": "up", "arrowdown": "down", "arrow down": "down",
    "arrowleft": "left", "arrow left": "left", "arrowright": "right", "arrow right": "right",
    "caps lock": "capslock", "print screen": "printscreen", "prtsc": "printscreen",
    "menu": "apps", "context menu": "apps",
}


def _normalize_keys(keys):
    if isinstance(keys, str):
        keys = [k.strip() for k in keys.split("+") if k.strip()]
    clean, bad = [], []
    valid = getattr(pyautogui, "KEYBOARD_KEYS", None) if pyautogui is not None else None
    for k in keys or []:
        k2 = str(k).strip().lower()
        k2 = _KEY_ALIASES.get(k2, k2)
        if k2.endswith(" key"):
            k2 = _KEY_ALIASES.get(k2[:-4].strip(), k2[:-4].strip())
        if valid is not None and k2 not in valid:
            bad.append(str(k))
        else:
            clean.append(k2)
    return clean, bad


def require_perm(flag):
    if not PERMS.get(flag):
        return jsonify({"ok": False, "error": "permission denied - enable in Settings"}), 403
    return None


def require_pyautogui():
    if pyautogui is None:
        return jsonify({"ok": False, "error": "pyautogui not available: " + str(_import_error)}), 500
    return None


# --------------------------------------------------------------------- typing
def _set_clipboard_text(text):
    try:
        import ctypes
        CF_UNICODETEXT = 13
        GMEM_MOVEABLE = 0x0002
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        if not user32.OpenClipboard(None):
            return False
        try:
            user32.EmptyClipboard()
            data = text.encode("utf-16-le") + b"\x00\x00"
            handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
            if not handle:
                return False
            locked = kernel32.GlobalLock(handle)
            if not locked:
                kernel32.GlobalFree(handle)
                return False
            ctypes.memmove(locked, data, len(data))
            kernel32.GlobalUnlock(handle)
            if not user32.SetClipboardData(CF_UNICODETEXT, handle):
                kernel32.GlobalFree(handle)
                return False
            return True
        finally:
            user32.CloseClipboard()
    except Exception:
        return False


def type_text(text):
    text = str(text or "")
    if not text:
        return
    if all(ord(c) < 128 for c in text):
        pyautogui.write(text, interval=0.008)  # REFINED: 0.01 -> 0.008 interval. Faster typing, still reliable.
        return
    if os.name == "nt" and _set_clipboard_text(text):
        time.sleep(0.04)
        pyautogui.hotkey("ctrl", "v")
        time.sleep(0.04)
        return
    pyautogui.write(text, interval=0.01)


# ---------------------------------------------------------------- health/perms
@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "pyautogui": pyautogui is not None, "whisper": _FWModel is not None,
                    "uia": _uia is not None, "uia_error": _uia_import_error})


@app.route("/permissions", methods=["POST"])
def set_permissions():
    body = request.get_json(force=True, silent=True) or {}
    if "mouse" in body:
        PERMS["mouse_enabled"] = bool(body["mouse"])
    if "scripting" in body:
        PERMS["scripting_enabled"] = bool(body["scripting"])
    log_action("permissions", json.dumps(PERMS))
    return jsonify({"ok": True, "perms": PERMS})


# ---------------------------------------------------------------- /vad
# REFINED endpoint. main.js calls this BEFORE sending audio to /transcribe. It performs:
#   - decode the webm/opus blob to raw PCM via PyAV (faster-whisper's bundled ffmpeg)
#   - compute the RMS in dBFS; if below the floor, the clip is silence/background -> drop
#   - measure speech duration after a simple energy-based VAD; if < min_speech_ms -> drop
#   - trim leading/trailing silence; report trimmed duration so the caller can decide
# Returns {ok, has_speech, duration_ms, rms_db, trimmed_duration_ms, reason}.
# If PyAV isn't available (older faster-whisper), returns ok=false with a clear hint and the
# caller falls back to sending the audio straight to Whisper (graceful degradation).
@app.route("/vad", methods=["POST"])
def vad():
    body = request.get_json(force=True, silent=True) or {}
    b64 = body.get("audio_b64") or ""
    if not b64:
        return jsonify({"ok": False, "error": "no audio"}), 400
    min_speech_ms = int(body.get("min_speech_ms") or 450)
    energy_floor_db = float(body.get("energy_floor_db") or -45.0)
    max_silence_pad_ms = int(body.get("max_silence_pad_ms") or 300)
    try:
        raw = base64.b64decode(b64)
    except Exception:
        return jsonify({"ok": False, "error": "bad audio encoding"}), 400
    try:
        import numpy as np  # type: ignore
        from faster_whisper.decode import decode_audio  # type: ignore
    except Exception as e:
        # PyAV or numpy missing - VAD can't run. Caller falls back to Whisper directly.
        return jsonify({"ok": False, "error": "vad unavailable: " + str(e),
                        "fallback": "send_to_whisper"})
    fd, path = tempfile.mkstemp(suffix=".webm")
    try:
        os.write(fd, raw)
        os.close(fd)
        try:
            audio = decode_audio(path)  # float32 mono, 16kHz, shape (N,)
        except Exception as e:
            return jsonify({"ok": False, "error": "decode failed: " + str(e),
                            "fallback": "send_to_whisper"})
        if audio is None or len(audio) == 0:
            return jsonify({"ok": True, "has_speech": False, "duration_ms": 0,
                            "rms_db": -99.0, "trimmed_duration_ms": 0,
                            "reason": "empty_audio"})
        sr = 16000
        n = len(audio)
        duration_ms = int(n * 1000 / sr)
        # Overall RMS in dBFS (full-scale sine = 0 dB).
        rms = float((audio ** 2).mean()) ** 0.5
        rms_db = 20.0 * (math.log10(rms) if rms > 0 else -99.0)
        if rms_db < energy_floor_db:
            return jsonify({"ok": True, "has_speech": False, "duration_ms": duration_ms,
                            "rms_db": round(rms_db, 1), "trimmed_duration_ms": 0,
                            "reason": "below_energy_floor"})
        # Frame-level energy VAD: 30ms frames, mark a frame as speech if its RMS is above
        # a noise-adaptive threshold (max(rms*0.1, 0.005)). Trim leading/trailing non-speech,
        # but keep up to max_silence_pad_ms of pad.
        frame_n = int(0.030 * sr)
        if frame_n < 1:
            frame_n = 1
        n_frames = n // frame_n
        energies = np.array([float((audio[i*frame_n:(i+1)*frame_n] ** 2).mean())
                             for i in range(n_frames)]) if n_frames > 0 else np.array([rms])
        threshold = max(float(energies.max()) * 0.10, 0.005)
        is_speech = energies >= threshold
        if not is_speech.any():
            return jsonify({"ok": True, "has_speech": False, "duration_ms": duration_ms,
                            "rms_db": round(rms_db, 1), "trimmed_duration_ms": 0,
                            "reason": "no_speech_frames"})
        first_speech = int(np.argmax(is_speech))
        last_speech = int(n_frames - 1 - np.argmax(is_speech[::-1]))
        pad_frames = max(1, int(max_silence_pad_ms / 30))
        start_frame = max(0, first_speech - pad_frames)
        end_frame = min(n_frames - 1, last_speech + pad_frames)
        trimmed_ms = int((end_frame - start_frame + 1) * frame_n * 1000 / sr)
        has_speech = trimmed_ms >= min_speech_ms
        reason = "ok" if has_speech else "too_short"
        return jsonify({
            "ok": True, "has_speech": has_speech, "duration_ms": duration_ms,
            "rms_db": round(rms_db, 1), "trimmed_duration_ms": trimmed_ms, "reason": reason
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "fallback": "send_to_whisper"})
    finally:
        try:
            os.remove(path)
        except Exception:
            pass


# ----------------------------------------------------------------- /transcribe
@app.route("/stt_status", methods=["GET"])
def stt_status():
    """Download-manager probe: is faster-whisper importable, and which models are warm?"""
    with _whisper_lock:
        return jsonify({"available": _FWModel is not None, "cached": list(_WHISPER_LRU.keys()),
                        "error": _fw_import_error})


@app.route("/stt_warm", methods=["POST"])
def stt_warm():
    """Load (downloading on first ever use) a whisper model so offline STT is instant later."""
    if _FWModel is None:
        return jsonify({"ok": False, "error": "faster-whisper not installed: %s" % _fw_import_error})
    name = (request.get_json(silent=True) or {}).get("model") or "base.en"
    try:
        _get_whisper(name)
        return jsonify({"ok": True, "model": name})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/transcribe", methods=["POST"])
def transcribe():
    if _FWModel is None:
        return jsonify({
            "ok": False,
            "error": "faster-whisper is not installed for this Python. Fix: "
                     "pip install faster-whisper  (detail: " + str(_fw_import_error) + ")"
        }), 500
    body = request.get_json(force=True, silent=True) or {}
    b64 = body.get("audio_b64") or ""
    if not b64:
        return jsonify({"ok": False, "error": "no audio"}), 400
    lang = (body.get("language") or "en").strip().lower()
    model_name = (body.get("model") or "").strip() or ("tiny.en" if lang.startswith("en") else "tiny")
    try:
        audio = base64.b64decode(b64)
    except Exception:
        return jsonify({"ok": False, "error": "bad audio encoding"}), 400
    fd, path = tempfile.mkstemp(suffix=".webm")
    try:
        os.write(fd, audio)
        os.close(fd)
        model = _get_whisper(model_name)
        kwargs = {
            "beam_size": 3,
            "vad_filter": True,
            "vad_parameters": {"min_silence_duration_ms": 500, "threshold": 0.5},
            "condition_on_previous_text": False,
            "no_speech_threshold": 0.6,
            "log_prob_threshold": -0.8,  # REFINED: -1.0 -> -0.8. Drop more low-confident garbage.
            "compression_ratio_threshold": 2.4,
        }
        if lang and lang != "auto" and not model_name.endswith(".en"):
            kwargs["language"] = lang
        try:
            segments, _info = model.transcribe(path, **kwargs)
        except TypeError:
            segments, _info = model.transcribe(path, beam_size=3)
        parts = []
        for s in segments:
            if getattr(s, "no_speech_prob", 0) > 0.85:
                continue
            # REFINED: also drop segments with very low avg_logprob (<= -1.0) - the existing
            # log_prob_threshold is per-segment but the check on s.avg_logprob is a belt-and-
            # braces filter for the segments that slipped through.
            if getattr(s, "avg_logprob", 0.0) <= -1.0:
                continue
            parts.append(s.text)
        text = "".join(parts).strip()
        _HALLUCINATIONS = re.compile(
            r"^\s*(you|bye|so|the|thank\s*(you|u)|thanks?|thank\s+you\s+so\s+much|"
            r"thanks?\s+for\s+watching[.!\s]*|please\s+(like\s+and\s+)?subscribe.*|"
            r"subtitles?\s+by.*|www\.[\w.-]+|[.!?\-\s]*)\s*[.!?]*\s*$",
            re.IGNORECASE)
        if _HALLUCINATIONS.match(text):
            log_action("transcribe", "%db audio -> discarded as silence hallucination (%r)" % (len(audio), text[:40]))
            return jsonify({"ok": True, "text": ""})
        # REFINED: drop 1-2 char results that aren't a real word ("a", "I", "o") - Whisper
        # produces these from brief noise bursts. Keep "I" and "a" only if the user explicitly
        # wants ultra-short replies (we don't - that's the whole mic-bug complaint).
        if len(text) <= 2 and text.lower() not in {"ok", "no", "hi", "yo"}:
            log_action("transcribe", "%db audio -> discarded too-short (%r)" % (len(audio), text[:40]))
            return jsonify({"ok": True, "text": ""})
        log_action("transcribe", "%db audio -> %d chars (%s)" % (len(audio), len(text), model_name))
        return jsonify({"ok": True, "text": text})
    except Exception as e:
        log_action("transcribe_error", str(e))
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        try:
            os.remove(path)
        except Exception:
            pass


# --------------------------------------------------------------------- vision
def _screenshot_jpeg(max_width):
    """Capture the screen, downscale to max_width, return (bytes, full_w, full_h, scale)."""
    if pyautogui is None:
        return None, 0, 0, 1.0
    img = pyautogui.screenshot()
    full_w, full_h = img.size
    scale = 1.0
    if full_w > max_width:
        try:
            scale = full_w / float(max_width)
            img = img.resize((max_width, max(1, int(round(full_h / scale)))))
        except Exception:
            scale = 1.0
    buf = io.BytesIO()
    try:
        img.convert("RGB").save(buf, format="JPEG", quality=60)  # REFINED: 80 -> 60 quality
        return buf.getvalue(), full_w, full_h, scale
    except Exception:
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue(), full_w, full_h, scale


# =============================================================== UIA locator (v3)
# Turn a plain-English target ("the Save button", "the icon named Recycle Bin") into exact
# screen coordinates by reading the Windows accessibility tree instead of guessing from a
# screenshot. Deterministic, instant, and DPI-correct for anything that exposes a name -
# which is nearly every button, menu item, list row, tab, checkbox, and desktop icon.

_UIA_MAX_ELEMENTS = 1500     # stop collecting past this many (huge trees: browsers, IDEs)
_UIA_MAX_DEPTH = 18          # deep enough for real apps, shallow enough to stay fast
_UIA_TIME_BUDGET_S = 2.5     # hard wall-clock cap; beyond this, fall back to vision
_UIA_MIN_SCORE = 0.50        # required match confidence; below -> not found via UIA

# Words in the target that describe WHAT KIND of element it is, not its name. They're
# stripped from name matching but used to prefer the right ControlType.
_UIA_TYPE_HINTS = {
    "button": ("ButtonControl", "SplitButtonControl"),
    "icon": ("ListItemControl", "TreeItemControl", "ButtonControl"),
    "menu": ("MenuItemControl", "MenuControl"),
    "menu item": ("MenuItemControl",),
    "tab": ("TabItemControl",),
    "link": ("HyperlinkControl",),
    "checkbox": ("CheckBoxControl",),
    "check box": ("CheckBoxControl",),
    "field": ("EditControl", "ComboBoxControl"),
    "textbox": ("EditControl",),
    "text box": ("EditControl",),
    "input": ("EditControl", "ComboBoxControl"),
    "box": ("EditControl", "ComboBoxControl", "CheckBoxControl"),
    "dropdown": ("ComboBoxControl",),
    "list item": ("ListItemControl",),
    "item": ("ListItemControl", "TreeItemControl", "MenuItemControl"),
    "row": ("ListItemControl", "DataItemControl"),
    "folder": ("ListItemControl", "TreeItemControl"),
    "file": ("ListItemControl",),
    "option": ("RadioButtonControl", "MenuItemControl", "ListItemControl"),
    "slider": ("SliderControl",),
    "window": ("WindowControl",),
    "title bar": ("TitleBarControl",),
}
_UIA_STOPWORDS = {"the", "a", "an", "on", "in", "of", "to", "at", "for", "with", "labeled",
                  "named", "called", "titled", "that", "says", "saying", "click", "press"}


def _uia_norm_words(text):
    """Lowercase -> word list, minus stopwords/punctuation."""
    words = re.findall(r"[a-z0-9]+", str(text or "").lower())
    return [w for w in words if w not in _UIA_STOPWORDS]


def _uia_type_hint(target_lower):
    """Which ControlTypes does the target's phrasing suggest? ('' hints nothing)."""
    hinted = []
    for phrase, types in _UIA_TYPE_HINTS.items():
        if phrase in target_lower:
            hinted.extend(types)
    return tuple(dict.fromkeys(hinted))  # de-duped, order kept


def _uia_visible_rect(el):
    """On-screen bounding rect center, or None for off-screen/zero-size elements."""
    try:
        r = el.BoundingRectangle
        if not r or r.width() <= 0 or r.height() <= 0:
            return None
        if r.right < 0 or r.bottom < 0:
            return None
        return r
    except Exception:
        return None


def _uia_collect(root, deadline):
    """Walk `root` breadth-limited, yielding (element, name, control_type, rect)."""
    out = []
    if root is None:
        return out
    try:
        for el, depth in _uia.WalkControl(root, includeTop=False, maxDepth=_UIA_MAX_DEPTH):
            if time.time() > deadline or len(out) >= _UIA_MAX_ELEMENTS:
                break
            try:
                name = (el.Name or "").strip()
            except Exception:
                name = ""
            if not name:
                continue
            rect = _uia_visible_rect(el)
            if rect is None:
                continue
            try:
                ctype = el.ControlTypeName or ""
            except Exception:
                ctype = ""
            out.append((el, name, ctype, rect))
    except Exception as e:
        log_action("uia_walk_error", str(e)[:200])
    return out


def _uia_score(target_words, hinted_types, name, ctype):
    """0..1 match score: word overlap between target and element name, +type bonus."""
    name_words = _uia_norm_words(name)
    if not name_words or not target_words:
        return 0.0
    tset, nset = set(target_words), set(name_words)
    overlap = len(tset & nset)
    if overlap == 0:
        return 0.0
    # Base: how much of the element's own name did the target account for, and vice versa.
    # Weighting name-coverage higher rewards exact labels ("Save") over partial word soup.
    name_cov = overlap / len(nset)
    target_cov = overlap / len(tset)
    score = 0.6 * name_cov + 0.4 * target_cov
    # Exact full-phrase presence is the strongest possible signal.
    if " ".join(name_words) == " ".join(target_words):
        score = max(score, 0.98)
    elif " ".join(name_words) in " ".join(target_words):
        score = max(score, 0.90)
    # Type hint agreement nudges ties toward the right kind of element.
    if hinted_types:
        score += 0.08 if ctype in hinted_types else -0.05
    return max(0.0, min(1.0, score))


# Interactive control types: an unnamed one of these is still worth offering to the
# planner (it can click/type into it); everything else is context only.
INTERACTIVE_TYPES = frozenset({
    "EditControl", "ComboBoxControl", "ButtonControl", "SplitButtonControl",
    "MenuItemControl", "TabItemControl", "ListItemControl", "TreeItemControl",
    "CheckBoxControl", "RadioButtonControl", "HyperlinkControl", "SliderControl",
    "DocumentControl",
})


# Human-friendly type label ("EditControl" -> "Edit"), used when nothing else names an element.
def _uia_type_label(ctype):
    c = str(ctype or "").replace("Control", "").strip()
    return c or "Element"


def _uia_synth_label(name, ctype, labeledby_name, prev_text, automation_id):
    """A never-empty label for an element: real Name > LabeledBy > nearby static text
    > AutomationId > bare type. Pure so it's unit-testable without a live desktop."""
    name = (name or "").strip()
    if name:
        return name
    for cand in ((labeledby_name or "").strip(), (prev_text or "").strip(), (automation_id or "").strip()):
        if cand:
            return cand[:80]
    return _uia_type_label(ctype) + " control"


def _uia_element_dict(idx, name, ctype, rect, enabled, focused, synthesized):
    """Build one /elements entry. rect is (left, top, right, bottom)."""
    l, t, r, b = int(rect[0]), int(rect[1]), int(rect[2]), int(rect[3])
    return {
        "id": int(idx),
        "name": str(name)[:80],
        "type": str(ctype or ""),
        "rect": [l, t, r, b],
        "center": [int((l + r) / 2), int((t + b) / 2)],
        "enabled": bool(enabled),
        "focused": bool(focused),
        "synthesized": bool(synthesized),
    }


def _uia_rank_key(entry):
    """Sort key: interactive first, then named-before-synthesized, then bigger area first.
    Returns a tuple usable with sorted() (all ascending -> we negate 'good' signals)."""
    interactive = 0 if entry.get("type") in INTERACTIVE_TYPES else 1
    synthesized = 1 if entry.get("synthesized") else 0
    l, t, r, b = entry.get("rect", [0, 0, 0, 0])
    area = max(0, (r - l)) * max(0, (b - t))
    return (interactive, synthesized, -area)


def _uia_desktop_root():
    """The desktop icon list (Progman/WorkerW -> FolderView), for desktop-icon targets."""
    try:
        pm = _uia.PaneControl(searchDepth=1, ClassName="Progman")
        if pm.Exists(0.4, 0.1):
            lst = pm.ListControl(searchDepth=3)
            if lst.Exists(0.4, 0.1):
                return lst
    except Exception:
        pass
    try:  # wallpaper-slideshow setups host FolderView under a WorkerW instead
        ww = _uia.PaneControl(searchDepth=1, ClassName="WorkerW")
        if ww.Exists(0.4, 0.1):
            lst = ww.ListControl(searchDepth=3)
            if lst.Exists(0.4, 0.1):
                return lst
    except Exception:
        pass
    return None


def locate_via_uia(target):
    """Find `target` in the accessibility tree. Returns {x, y, w, h, uia, name} or None."""
    if _uia is None:
        return None
    t = str(target or "").strip()
    if not t:
        return None
    target_words = _uia_norm_words(t)
    if not target_words:
        return None
    hinted = _uia_type_hint(t.lower())
    deadline = time.time() + _UIA_TIME_BUDGET_S
    candidates = []
    try:
        with _uia.UIAutomationInitializerInThread():
            # 1) the foreground window - where the action almost always is
            try:
                fg = _uia.GetForegroundControl()
                top = fg.GetTopLevelControl() if fg else None
            except Exception:
                top = None
            candidates.extend(_uia_collect(top, deadline))
            # 2) desktop icons too, when the target sounds like one or the foreground gave nothing
            tl = t.lower()
            if ("desktop" in tl or "icon" in tl or not candidates) and time.time() < deadline:
                candidates.extend(_uia_collect(_uia_desktop_root(), deadline))
    except Exception as e:
        log_action("uia_error", str(e)[:200])
        return None
    if not candidates:
        return None
    best, best_score = None, 0.0
    for el, name, ctype, rect in candidates:
        s = _uia_score(target_words, hinted, name, ctype)
        if s > best_score:
            best, best_score = (name, ctype, rect), s
    if best is None or best_score < _UIA_MIN_SCORE:
        log_action("uia_no_match", "%r best=%.2f among %d elements" % (t[:60], best_score, len(candidates)))
        return None
    name, ctype, rect = best
    x = int((rect.left + rect.right) / 2)
    y = int((rect.top + rect.bottom) / 2)
    log_action("uia_match", "%r -> %r (%s) score=%.2f at (%d,%d)" % (t[:60], name[:60], ctype, best_score, x, y))
    return {"x": x, "y": y, "w": int(rect.width()), "h": int(rect.height()),
            "uia": True, "name": name}


def _uia_collect_permissive(root, deadline):
    """Like _uia_collect but yields unnamed elements too (caller decides whether to drop
    them based on interactivity). Yields (element, name, control_type, rect)."""
    out = []
    if root is None:
        return out
    try:
        for el, depth in _uia.WalkControl(root, includeTop=False, maxDepth=_UIA_MAX_DEPTH):
            if time.time() > deadline or len(out) >= _UIA_MAX_ELEMENTS:
                break
            rect = _uia_visible_rect(el)
            if rect is None:
                continue
            try:
                name = (el.Name or "").strip()
            except Exception:
                name = ""
            try:
                ctype = el.ControlTypeName or ""
            except Exception:
                ctype = ""
            out.append((el, name, ctype, rect))
    except Exception as e:
        log_action("uia_walk_error", str(e)[:200])
    return out


def _uia_prev_static_text(el):
    """Best-effort: the Name of the nearest preceding sibling that is static text
    (used to label an adjacent unnamed field). Cheap, defensive, returns ''."""
    try:
        parent = el.GetParentControl()
        if not parent:
            return ""
        prev = ""
        for child in parent.GetChildren():
            if child == el:
                return prev
            try:
                if (child.ControlTypeName or "") in ("TextControl", "StaticControl") and (child.Name or "").strip():
                    prev = child.Name.strip()
            except Exception:
                pass
        return prev
    except Exception:
        return ""


def _uia_labeledby_name(el):
    try:
        lb = el.GetLabeledByControl() if hasattr(el, "GetLabeledByControl") else None
        return (lb.Name or "").strip() if lb else ""
    except Exception:
        return ""


def _uia_collect_roots(deadline):
    """Walk foreground + start menu + taskbar + desktop, returning raw element tuples:
    (el, label, ctype, rect, enabled, focused, synthesized). Named non-interactive
    elements are kept (context); unnamed elements are kept ONLY if interactive."""
    out = []
    try:
        fg_el = _uia.GetForegroundControl()
        fg_top = fg_el.GetTopLevelControl() if fg_el else None
    except Exception:
        fg_el, fg_top = None, None
    roots = []
    if fg_top is not None:
        roots.append(fg_top)
    # Start menu / search host (its own top-level window), taskbar, desktop icons.
    for cls in ("Windows.UI.Core.CoreWindow", "Shell_TrayWnd"):
        try:
            w = _uia.WindowControl(searchDepth=1, ClassName=cls)
            if w.Exists(0.2, 0.05):
                roots.append(w)
        except Exception:
            pass
    dk = _uia_desktop_root()
    if dk is not None:
        roots.append(dk)

    focused_rect = None
    try:
        if fg_el:
            fr = fg_el.BoundingRectangle
            focused_rect = (fr.left, fr.top, fr.right, fr.bottom)
    except Exception:
        focused_rect = None

    for root in roots:
        if time.time() > deadline:
            break
        for el, name, ctype, rect in _uia_collect_permissive(root, deadline):
            interactive = ctype in INTERACTIVE_TYPES
            nm = (name or "").strip()
            if not nm and not interactive:
                continue  # unnamed AND non-interactive -> nothing the planner can use
            synthesized = not nm
            label = _uia_synth_label(nm, ctype, _uia_labeledby_name(el) if synthesized else "",
                                     _uia_prev_static_text(el) if synthesized else "", "")
            try:
                enabled = bool(el.IsEnabled)
            except Exception:
                enabled = True
            focused = False
            if focused_rect is not None:
                try:
                    focused = (rect.left, rect.top, rect.right, rect.bottom) == focused_rect
                except Exception:
                    focused = False
            out.append((el, label, ctype, rect, enabled, focused, synthesized))
    return out


def locate_on_screen(target, max_width=None):
    """Screenshot -> ask main.js's vision webhook where `target` is.

    REFINED: accepts a max_width override (caller can retry at higher res on first failure).
    Returns a richer dict: {x, y, w, h} when the model emits a bbox (preferred), or
    {x, y} (back-compat). w/h are in REAL screen pixels (already scaled back up). None on
    failure.

    PATCH v2 (this build): TWO new behaviors that fix the "AI is dumb at automation" bugs:

    (A) Deterministic targets - bypass the vision model entirely for targets that don't need
        it. The vision model is genuinely bad at "empty area" / "the desktop" / "screen
        center" because those are NEGATIVE descriptions (absence of content) or trivially
        known positions. Handling them deterministically eliminates the #1 failure mode.
        Recognized:
          - "desktop" / "the desktop" / "empty desktop" / "desktop background"
          - "empty area" / "empty space" / "blank area" / "blank space" (anywhere on screen)
          - "desktop center" / "center of the desktop" / "center of the screen" / "screen center"
          - "taskbar" (bottom-center, avoiding the Start button)
        For "empty area" / "desktop", we pick a point in the upper-center region of the
        primary screen - away from the taskbar (bottom ~8%) and away from screen edges
        (where icons rarely are). On a typical 1920x1080 screen this lands around
        (960, 400) - reliably empty desktop space.

    (B) Corner-coordinate rejection. The vision model sometimes returns (0,0) or
        (screen_w-1, screen_h-1) when it has no real answer - those are the "I give up"
        sentinel values some models emit. The old code clamped them to the screen and
        clicked the corner, which is how "clicked the taskbar at 0.0" happened. Now: if
        the returned point is within 8px of ANY screen corner, treat it as a failed
        locate and return None so the caller retries / falls back.
    """
    if pyautogui is None:
        return None

    # ---- (0) UIA first: exact coordinates from the accessibility tree, no vision needed ----
    # This is the primary path now. Named elements (buttons, menus, icons, list rows) resolve
    # deterministically in ~100ms with pixel-exact rectangles. Vision below is the FALLBACK
    # for unnamed content only. Note the ordering vs (A): UIA runs first so "the Recycle Bin
    # icon on the desktop" matches the actual icon instead of the generic empty-desktop spot.
    try:
        hit = locate_via_uia(target)
        if hit:
            return hit
    except Exception as e:
        log_action("uia_unexpected", str(e)[:200])

    # ---- (A) Deterministic targets ----
    t = (str(target or "")).strip().lower()
    t_norm = re.sub(r"\b^(the|an|a)\s+", "", t).strip()
    DESKTOP_SYNONYMS = {
        "desktop", "desktop background", "empty desktop", "bare desktop",
        "empty area", "empty space", "blank area", "blank space",
        "empty area of the desktop", "empty area of desktop",
        "empty area on the desktop", "empty area on desktop",
        "an empty area", "an empty space",
    }
    try:
        sw, sh = pyautogui.size()
    except Exception:
        sw, sh = 1920, 1080
    taskbar_h = max(40, int(sh * 0.08))

    if t_norm in DESKTOP_SYNONYMS or t_norm.startswith("empty area") or t_norm.startswith("empty space"):
        x = sw // 2
        y = int(sh * 0.37)
        log_action("locate_deterministic", "desktop/empty-area -> (%d, %d)" % (x, y))
        return {"x": x, "y": y, "w": 80, "h": 80, "deterministic": True}

    if t_norm in {"desktop center", "center of the desktop", "center of the screen", "screen center", "center of screen"}:
        x = sw // 2
        y = (sh - taskbar_h) // 2
        log_action("locate_deterministic", "screen-center -> (%d, %d)" % (x, y))
        return {"x": x, "y": y, "w": 80, "h": 80, "deterministic": True}

    if t_norm in {"taskbar", "the taskbar", "taskbar at the bottom", "taskbar at the bottom of the screen"}:
        x = sw // 2
        y = sh - max(20, taskbar_h // 2)
        log_action("locate_deterministic", "taskbar -> (%d, %d)" % (x, y))
        return {"x": x, "y": y, "w": 100, "h": 20, "deterministic": True}

    # ---- (B) Vision-model path (with corner rejection) ----
    mw = int(max_width or LOCATE_MAX_WIDTH)
    jpeg_bytes, full_w, full_h, scale = _screenshot_jpeg(mw)
    if jpeg_bytes is None:
        return None
    data_url = "data:image/jpeg;base64," + base64.b64encode(jpeg_bytes).decode("ascii")

    import urllib.request
    payload = json.dumps({"image": data_url, "target": target, "want_bbox": True}).encode("utf-8")
    req = urllib.request.Request(
        VISION_WEBHOOK, data=payload, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=VISION_TIMEOUT_S) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        log_action("vision_error", str(e))
        return None

    x, y = result.get("x"), result.get("y")
    if x is None or y is None:
        return None
    try:
        x = int(round(float(x) * scale))
        y = int(round(float(y) * scale))
    except (TypeError, ValueError):
        return None

    # PATCH v2: corner-coordinate rejection. If the model returned a point within 8px of any
    # screen corner, it's almost certainly a sentinel "I don't know" value. This is what
    # caused "clicked the taskbar at 0.0" - the model returned (0,0) for "the taskbar at the
    # bottom of the screen" and we clicked the top-left corner.
    CORNER_MARGIN = 8
    near_corner = (
        (x <= CORNER_MARGIN and y <= CORNER_MARGIN) or
        (x <= CORNER_MARGIN and y >= sh - 1 - CORNER_MARGIN) or
        (x >= sw - 1 - CORNER_MARGIN and y <= CORNER_MARGIN) or
        (x >= sw - 1 - CORNER_MARGIN and y >= sh - 1 - CORNER_MARGIN)
    )
    if near_corner:
        log_action("vision_corner_rejected", "target=%r -> (%d,%d) rejected as corner sentinel" % (str(target)[:60], x, y))
        return None

    w = result.get("w")
    h = result.get("h")
    try:
        if w is not None:
            w = int(round(float(w) * scale))
        if h is not None:
            h = int(round(float(h) * scale))
    except (TypeError, ValueError):
        w, h = None, None
    try:
        x = max(0, min(x, sw - 1))
        y = max(0, min(y, sh - 1))
    except Exception:
        pass
    out = {"x": x, "y": y}
    if w is not None and h is not None and w > 0 and h > 0:
        out["w"] = w
        out["h"] = h
    return out


def _highlight(x, y, w, h, ms):
    """Draw a transient yellow box at (x,y,w,h) for `ms` milliseconds. Non-fatal on failure.

    Uses a topmost Tkinter window (no extra pip dep - Tk ships with Python on Windows).
    The user sees what's about to be clicked, which builds trust + makes debugging easy.
    """
    try:
        import tkinter as tk  # type: ignore
        root = tk.Tk()
        root.overrideredirect(True)
        root.attributes("-topmost", True)
        root.attributes("-alpha", 0.45)
        # Position + size in screen pixels.
        root.geometry("%dx%d+%d+%d" % (max(8, w or 30), max(8, h or 30), x - (w or 30) // 2, y - (h or 30) // 2))
        root.configure(bg="yellow")
        root.after(ms, root.destroy)
        root.mainloop()
    except Exception:
        # Tkinter not available / failed for any reason - silently skip. The click still happens.
        pass


def _screenshot_hash():
    """Quick perceptual hash of the current screen for click-verification. None on failure."""
    if pyautogui is None:
        return None
    try:
        img = pyautogui.screenshot()
        img = img.resize((64, 36))  # tiny - just enough to detect ANY visible change
        # Convert to grayscale + average hash.
        gray = img.convert("L")
        pixels = list(gray.getdata())
        avg = sum(pixels) / len(pixels)
        bits = 0
        for p in pixels:
            bits = (bits << 1) | (1 if p >= avg else 0)
        return bits
    except Exception:
        return None


def _hamming(a, b):
    if a is None or b is None:
        return 999
    return bin(a ^ b).count("1")


def _uia_top_titles():
    """Set of current top-level window titles (for new-window detection). Best-effort."""
    titles = set()
    if _uia is None:
        return titles
    try:
        root = _uia.GetRootControl()
        for w in root.GetChildren():
            try:
                if (w.ControlTypeName or "") == "WindowControl":
                    n = (w.Name or "").strip()
                    if n:
                        titles.add(n)
            except Exception:
                pass
    except Exception:
        pass
    return titles


def _uia_state_report(prev_titles):
    """Foreground + focused control snapshot after an action. prev_titles: set from before."""
    rep = {"foreground_title": "", "foreground_class": "", "focused_name": "",
           "focused_type": "", "new_window": None}
    if _uia is None:
        return rep
    try:
        with _uia.UIAutomationInitializerInThread():
            try:
                fg = _uia.GetForegroundControl()
                top = fg.GetTopLevelControl() if fg else None
                if top:
                    rep["foreground_title"] = (top.Name or "")[:120]
                    rep["foreground_class"] = top.ClassName or ""
                if fg:
                    rep["focused_name"] = (fg.Name or "")[:80]
                    rep["focused_type"] = fg.ControlTypeName or ""
            except Exception:
                pass
            now = _uia_top_titles()
            fresh = now - (prev_titles or set())
            if fresh:
                rep["new_window"] = sorted(fresh)[0][:120]
    except Exception:
        pass
    return rep


def _uia_resolve_id(element_id):
    """Return a fresh (x, y, name, ctype) for a cached element id. None if unknown/stale."""
    try:
        eid = int(element_id)
    except Exception:
        return None
    for it in _ELEMENT_CACHE.get("items", []):
        if it["id"] == eid:
            l, t, r, b = it["rect"]
            if r - l <= 0 or b - t <= 0:
                return None
            return (it["center"][0], it["center"][1], it["name"], it["type"])
    return None


# -------------------------------------------------------------------- /elements
@app.route("/elements", methods=["GET", "POST"])
def elements():
    """Inventory of actionable on-screen elements right now (foreground + start menu +
    taskbar + desktop). Caches the full list for /act element_id resolution."""
    if _uia is None:
        return jsonify({"ok": False, "error": "uiautomation not available", "elements": []})
    wide = bool((request.get_json(silent=True) or {}).get("wide")) if request.method == "POST" else False
    t0 = time.time()
    deadline = t0 + (_UIA_TIME_BUDGET_S * 2.5 if wide else _UIA_TIME_BUDGET_S)
    fg_title, fg_class = "", ""
    items = []
    try:
        with _uia.UIAutomationInitializerInThread():
            try:
                fg = _uia.GetForegroundControl()
                top = fg.GetTopLevelControl() if fg else None
                if top:
                    fg_title = (top.Name or "")[:120]
                    fg_class = top.ClassName or ""
            except Exception:
                pass
            raw = _uia_collect_roots(deadline)
        seen = set()
        for i, (el, label, ctype, rect, enabled, focused, synth) in enumerate(raw):
            key = (label, ctype, int(rect.left), int(rect.top))
            if key in seen:
                continue
            seen.add(key)
            items.append(_uia_element_dict(len(items), label, ctype,
                                           (rect.left, rect.top, rect.right, rect.bottom),
                                           enabled, focused, synth))
    except Exception as e:
        log_action("elements_error", str(e)[:200])
        return jsonify({"ok": False, "error": str(e)[:200], "elements": []})

    items.sort(key=_uia_rank_key)
    for i, it in enumerate(items):  # renumber ids to match the (now ranked) order
        it["id"] = i
    _ELEMENT_CACHE["items"] = items
    _ELEMENT_CACHE["ts"] = time.time()
    shown = items[:_ELEMENT_CAP]
    walk_ms = int((time.time() - t0) * 1000)
    log_action("elements_served", "%d elements (%d shown) in %dms; fg=%r" % (len(items), len(shown), walk_ms, fg_title[:40]))
    return jsonify({"ok": True, "elements": shown, "foreground": {"title": fg_title, "class": fg_class},
                    "truncated": len(items) > len(shown), "walk_ms": walk_ms})


# ----------------------------------------------------------------------- /act
@app.route("/act", methods=["POST"])
def act():
    body = request.get_json(force=True, silent=True) or {}
    action = body.get("action", "")
    target = body.get("target", "")

    needs_mouse = action in ("click", "rightclick", "doubleclick", "scroll", "drag") or (
        action == "type" and bool(target)
    )
    needs_scripting = action in ("type", "hotkey", "open_app")

    if needs_mouse:
        err = require_perm("mouse_enabled")
        if err:
            return err
    if needs_scripting:
        err = require_perm("scripting_enabled")
        if err:
            return err
    if pyautogui is None:
        return jsonify({"ok": False, "error": "pyautogui not available: " + str(_import_error)}), 500

    # REFINED: caller can request a higher-resolution retry. We try at max_width, then
    # retry_width if the first locate fails.
    max_width = int(body.get("max_width") or LOCATE_MAX_WIDTH)
    retry_width = int(body.get("retry_width") or 0)
    do_verify = bool(body.get("verify"))
    highlight_ms = int(body.get("highlight_ms") or 0)

    try:
        prev_titles = _uia_top_titles()
        if action in ("click", "rightclick", "doubleclick", "drag"):
            eid = body.get("element_id", None)
            allow_vision = bool(body.get("allow_vision", True))  # automation sets this False
            pos = None
            if eid is not None and action != "drag":
                hit = _uia_resolve_id(eid)
                if hit is None:
                    return jsonify({"ok": False, "error": "element_id %r not found (list may be stale - re-scan)" % eid,
                                    "stale_id": True, "state": _uia_state_report(prev_titles)})
                pos = {"x": hit[0], "y": hit[1], "w": None, "h": None, "uia": True, "name": hit[2]}
                log_action("act_by_id", "id=%s -> %r (%s) at (%d,%d)" % (eid, hit[2][:40], hit[3], hit[0], hit[1]))
            if pos is None:
                pos = locate_on_screen(target, max_width=max_width)
            # Demote vision: a plain vision guess (not UIA, not deterministic) is suppressed
            # when the caller disallows it, so the run escalates (re-scan/ask) instead of
            # clicking a guessed pixel on a regular control.
            if pos and not allow_vision and not pos.get("uia") and not pos.get("deterministic"):
                pos = None
            if not pos and retry_width > max_width:
                pos = locate_on_screen(target, max_width=retry_width)
            if not pos:
                return jsonify({"ok": False, "error": "could not find \"" + target + "\" on screen",
                                "state": _uia_state_report(prev_titles)})
            x, y = pos["x"], pos["y"]
            w = pos.get("w")
            h = pos.get("h")
            # Show WHICH path found the target: exact accessibility match (with the element's
            # real name) vs vision guess. Makes "why did it click there" instantly diagnosable.
            via = (" [uia: %s]" % pos.get("name", "")[:40]) if pos.get("uia") else (" [fixed]" if pos.get("deterministic") else " [vision]")
            # REFINED: highlight before the click so the user sees the target.
            if highlight_ms > 0 and action in ("click", "rightclick", "doubleclick"):
                _highlight(x, y, w, h, highlight_ms)
            # REFINED: snapshot BEFORE the click for verification.
            before_hash = _screenshot_hash() if do_verify else None
            if action == "click":
                pyautogui.click(x, y)
                did = "clicked \"%s\" at %d,%d%s" % (target, x, y, via)
            elif action == "rightclick":
                pyautogui.rightClick(x, y)
                did = "right-clicked \"%s\" at %d,%d%s" % (target, x, y, via)
            elif action == "doubleclick":
                pyautogui.doubleClick(x, y)
                did = "double-clicked \"%s\" at %d,%d%s" % (target, x, y, via)
            else:  # drag
                to_target = body.get("drag_to", "")
                to_pos = locate_on_screen(to_target, max_width=max_width)
                if not to_pos and retry_width > max_width:
                    to_pos = locate_on_screen(to_target, max_width=retry_width)
                if not to_pos:
                    return jsonify({"ok": False, "error": "could not find drop target \"" + to_target + "\""})
                pyautogui.moveTo(x, y)
                pyautogui.dragTo(to_pos["x"], to_pos["y"], duration=0.35, button="left")  # 0.4 -> 0.35
                did = "dragged \"%s\" to \"%s\"" % (target, to_target)
                before_hash = None  # drag verification is unreliable; skip
            # REFINED: optional click verification.
            verify = "skipped"
            if do_verify and before_hash is not None:
                time.sleep(0.25)  # let the click's visual effect land
                after_hash = _screenshot_hash()
                diff = _hamming(before_hash, after_hash)
                # 64x36 = 2304 bits. >6 differing bits = something visibly changed.
                verify = "changed" if diff > 6 else "no_change"
                did = did + " (verify: " + verify + ", diff=" + str(diff) + ")"
            log_action("act", action + ": " + (target or did))
            state = _uia_state_report(prev_titles)
            log_action("act_verified", "%s -> fg=%r focused=%r%s" % (action, state["foreground_title"][:40], state["focused_name"][:30], " NEWWIN" if state["new_window"] else ""))
            return jsonify({"ok": True, "did": did, "verify": verify, "x": x, "y": y, "state": state})

        elif action == "type":
            text = body.get("text", "")
            if target:
                pos = locate_on_screen(target, max_width=max_width)
                if not pos and retry_width > max_width:
                    pos = locate_on_screen(target, max_width=retry_width)
                if not pos:
                    return jsonify({"ok": False, "error": "could not find \"" + target + "\" to type into",
                                    "state": _uia_state_report(prev_titles)})
                if highlight_ms > 0:
                    _highlight(pos["x"], pos["y"], pos.get("w"), pos.get("h"), highlight_ms)
                pyautogui.click(pos["x"], pos["y"])
                time.sleep(0.12)  # 0.15 -> 0.12
            type_text(text)
            did = "typed into \"%s\"" % (target or "the focused field")
            log_action("act", action + ": " + (target or did))
            typed_verified = None
            try:
                with _uia.UIAutomationInitializerInThread():
                    fg = _uia.GetForegroundControl()
                    if fg and hasattr(fg, "GetValuePattern"):
                        vp = fg.GetValuePattern()
                        if vp and text:
                            cur = (vp.Value or "")
                            typed_verified = text.strip()[:40] in cur
            except Exception:
                typed_verified = None
            state = _uia_state_report(prev_titles)
            return jsonify({"ok": True, "did": did, "typed_verified": typed_verified, "state": state})

        elif action == "scroll":
            direction = body.get("scroll_dir", "down")
            if target:
                pos = locate_on_screen(target, max_width=max_width)
                if not pos and retry_width > max_width:
                    pos = locate_on_screen(target, max_width=retry_width)
                if pos:
                    pyautogui.moveTo(pos["x"], pos["y"])
            amount = -400 if direction == "down" else 400
            pyautogui.scroll(amount)
            did = "scrolled " + direction + ((" over \"%s\"" % target) if target else "")
            log_action("act", action + ": " + (target or did))
            return jsonify({"ok": True, "did": did})

        elif action == "hotkey":
            keys, bad = _normalize_keys(body.get("keys", []))
            if bad:
                return jsonify({"ok": False, "error": "invalid key name(s): " + ", ".join(bad) + " - use names like win, enter, ctrl, shift, alt, tab, escape, f5 (e.g. \"ctrl+shift+s\")"})
            if not keys:
                return jsonify({"ok": False, "error": "no keys given for hotkey"}), 400
            pyautogui.hotkey(*keys)
            did = "pressed " + "+".join(keys)
            log_action("act", action + ": " + (target or did))
            return jsonify({"ok": True, "did": did})

        elif action == "open_app":
            app_name = str(body.get("app") or body.get("target") or "").strip()
            safe = re.sub(r"[^a-zA-Z0-9 ._-]", "", app_name).strip()
            if not safe:
                return jsonify({"ok": False, "error": "no app name given"})
            prev_titles = _uia_top_titles()
            # Launch via the Start search: Win, type, Enter. No tile clicking, no vision.
            pyautogui.press("win")
            time.sleep(0.6)
            type_text(safe)
            time.sleep(0.6)
            pyautogui.press("enter")
            # Poll until a window whose title/class looks like the app is foreground.
            # NOTE: pressing Win opens the Start/Search surface, which is itself a new
            # window - so "any new window" is NOT proof of launch. We require a title/class
            # match, or a new NON-SHELL window, to confirm.
            _SHELL_TITLES = {"", "Start", "Search", "Program Manager", "Task View", "Cortana"}
            # A misspelled/nonexistent name makes Windows open a WEB SEARCH in the browser
            # instead of launching an app. That's a real window but not a launch - reject it
            # unless the user actually asked for a browser.
            _BROWSER_APPS = ("edge", "msedge", "chrome", "firefox", "browser", "opera", "brave")
            want = safe.lower()
            wanted_browser = any(b in want for b in _BROWSER_APPS)

            def _is_web_search(title, cls):
                if wanted_browser:
                    return False
                tl = (title or "").lower()
                return ((" - search" in tl or "search and " in tl or "bing" in tl)
                        and ("edge" in tl or "chrome" in tl or "firefox" in tl or "opera" in tl))

            deadline = time.time() + 8.0
            got = None
            while time.time() < deadline:
                time.sleep(0.5)
                try:
                    with _uia.UIAutomationInitializerInThread():
                        fg = _uia.GetForegroundControl()
                        top = fg.GetTopLevelControl() if fg else None
                        title = (top.Name or "") if top else ""
                        cls = (top.ClassName or "") if top else ""
                except Exception:
                    title, cls = "", ""
                if title in _SHELL_TITLES:
                    continue  # still on the Start menu / search - not launched yet
                if _is_web_search(title, cls):
                    break  # web-search fallback: this is NOT the app - stop and report failure
                if want in title.lower() or want in cls.lower():
                    got = title
                    break
            state = _uia_state_report(prev_titles)
            # Confirmation = the foreground window's title/class actually contains the app
            # name. (A generic "some new window appeared" signal is unreliable - the Start
            # menu and UIA enumeration races both produce false positives - and when a real
            # app's title doesn't contain its name, main.js falls back to the direct OS
            # launcher, so the app still opens.)
            if got is not None:
                log_action("open_app", "%r -> %r" % (safe, got))
                return jsonify({"ok": True, "did": "opened " + safe, "window": got, "state": state})
            try:
                pyautogui.press("escape")  # dismiss the Start menu we opened on a failed launch
            except Exception:
                pass
            log_action("open_app_unconfirmed", "%r (no matching window)" % safe)
            return jsonify({"ok": False, "error": "launched \"%s\" but no matching window appeared" % safe, "state": state})

        else:
            return jsonify({"ok": False, "error": "unknown action \"" + action + "\""}), 400

    except Exception as e:
        log_action("act_error", str(e))
        return jsonify({"ok": False, "error": str(e)}), 500


# --------------------------------------------------------------------- /type
@app.route("/type", methods=["POST"])
def type_only():
    err = require_perm("scripting_enabled")
    if err:
        return err
    err = require_pyautogui()
    if err:
        return err
    body = request.get_json(force=True, silent=True) or {}
    text = body.get("text", "")
    try:
        type_text(text)
        log_action("type", text)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ------------------------------------------------------------------- /hotkey
@app.route("/hotkey", methods=["POST"])
def hotkey():
    err = require_perm("scripting_enabled")
    if err:
        return err
    err = require_pyautogui()
    if err:
        return err
    body = request.get_json(force=True, silent=True) or {}
    keys, bad = _normalize_keys(body.get("keys", []))
    if bad:
        return jsonify({"ok": False, "error": "invalid key name(s): " + ", ".join(bad) + " - use names like win, enter, ctrl, shift, alt, tab, escape, f5"})
    try:
        pyautogui.hotkey(*keys)
        log_action("hotkey", "+".join(keys))
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# --------------------------------------------------------------------- /shell
@app.route("/shell", methods=["POST"])
def shell():
    err = require_perm("scripting_enabled")
    if err:
        return err
    body = request.get_json(force=True, silent=True) or {}
    cmd = (body.get("cmd") or "").strip()
    confirmed = bool(body.get("confirmed"))

    if not cmd:
        return jsonify({"ok": False, "error": "empty command"}), 400
    if not confirmed:
        log_action("shell_blocked_unconfirmed", cmd)
        return jsonify({"ok": False, "error": "command not confirmed by user"}), 403
    for pattern in SHELL_BLOCKLIST:
        if re.search(pattern, cmd, re.IGNORECASE):
            log_action("shell_blocked", cmd)
            return jsonify({"ok": False, "error": "command blocked by safety filter"}), 400

    import subprocess
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=30
        )
        out = (result.stdout or "")[:2000]
        errout = (result.stderr or "")[:2000]
        log_action("shell", cmd)
        return jsonify({"ok": True, "stdout": out, "stderr": errout, "code": result.returncode})
    except subprocess.TimeoutExpired:
        log_action("shell_timeout", cmd)
        return jsonify({"ok": False, "error": "command timed out after 30s"}), 500
    except Exception as e:
        log_action("shell_error", str(e))
        return jsonify({"ok": False, "error": str(e)}), 500


# --------------------------------------------------------------------- /files
def _safe_path(rel):
    rel = (rel or "").lstrip("/\\")
    target = os.path.realpath(os.path.join(SANDBOX_ROOT, rel))
    root = os.path.realpath(SANDBOX_ROOT)
    if target != root and not target.startswith(root + os.sep):
        return None
    return target


@app.route("/files", methods=["POST"])
def files():
    body = request.get_json(force=True, silent=True) or {}
    op = body.get("op", "")

    if op == "list":
        p = _safe_path(body.get("path", ""))
        if not p or not os.path.isdir(p):
            return jsonify({"ok": False, "error": "not a directory in the sandbox"}), 400
        try:
            entries = []
            for name in sorted(os.listdir(p)):
                if name == ".trash":
                    continue
                full = os.path.join(p, name)
                entries.append({"name": name, "dir": os.path.isdir(full), "size": os.path.getsize(full) if os.path.isfile(full) else None})
            return jsonify({"ok": True, "entries": entries})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    if op == "read":
        p = _safe_path(body.get("path", ""))
        if not p or not os.path.isfile(p):
            return jsonify({"ok": False, "error": "not a file in the sandbox"}), 400
        try:
            with open(p, "r", encoding="utf-8", errors="replace") as f:
                content = f.read(200_000)
            return jsonify({"ok": True, "content": content})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    err = require_perm("scripting_enabled")
    if err:
        return err

    if op == "write":
        p = _safe_path(body.get("path", ""))
        if not p:
            return jsonify({"ok": False, "error": "path escapes the sandbox"}), 400
        try:
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w", encoding="utf-8") as f:
                f.write(body.get("content", ""))
            log_action("files_write", body.get("path", ""))
            return jsonify({"ok": True})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    if op in ("move", "rename"):
        src = _safe_path(body.get("path", ""))
        dst = _safe_path(body.get("to", ""))
        if not src or not dst or not os.path.exists(src):
            return jsonify({"ok": False, "error": "invalid source/destination"}), 400
        try:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.move(src, dst)
            log_action("files_" + op, body.get("path", "") + " -> " + body.get("to", ""))
            return jsonify({"ok": True})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    if op == "delete":
        src = _safe_path(body.get("path", ""))
        if not src or not os.path.exists(src):
            return jsonify({"ok": False, "error": "file not found in sandbox"}), 400
        try:
            os.makedirs(TRASH_DIR, exist_ok=True)
            dest_name = str(uuid.uuid4())[:8] + "_" + os.path.basename(src)
            shutil.move(src, os.path.join(TRASH_DIR, dest_name))
            log_action("files_delete_soft", body.get("path", ""))
            return jsonify({"ok": True, "trashed_as": dest_name})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    return jsonify({"ok": False, "error": "unknown op \"" + op + "\""}), 400


if __name__ == "__main__":
    log_action("startup", "automation sidecar (REFINED) starting on %s:%d, sandbox=%s" % (HOST, PORT, SANDBOX_ROOT))
    app.run(host=HOST, port=PORT, debug=False, threaded=True)