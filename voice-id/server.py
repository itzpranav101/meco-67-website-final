"""
Local voice-recognition backend for Meco.

Runs entirely on this machine, no account/API key required. Meco's Node server
proxies /api/voice/* to this process so the browser never talks to it directly
and every request is scoped to the signed-in Clerk account.

Enrollment and identification use Resemblyzer (an offline neural voice-embedding
model). Voiceprints are persisted to voiceprints.json next to this file, so they
survive restarts.

Run with:  python voice-id/server.py
"""

import base64
import json
import os
import tempfile

import numpy as np
from flask import Flask, jsonify, request
from werkzeug.exceptions import HTTPException
from resemblyzer import VoiceEncoder, preprocess_wav

app = Flask(__name__)
encoder = VoiceEncoder()

@app.errorhandler(Exception)
def handle_any_exception(e):
    if isinstance(e, HTTPException):
        return jsonify({"error": e.description}), e.code
    app.logger.exception("Unhandled error")
    return jsonify({"error": "Could not process that audio (%s)" % e.__class__.__name__}), 500

DATA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voiceprints.json")
PALETTE = ["#7c5cff", "#00d4c8", "#ff8fab", "#ffcb6e", "#5ee6b0", "#6fb2ff", "#ff8a5c", "#c9a4ff"]
MIN_USABLE_SAMPLES = 8000  # ~0.5s of voiced audio at 16kHz after VAD trimming

def load_speakers():
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, "r") as f:
            loaded = json.load(f)
        for s in loaded:
            s.setdefault("enabled", True)  # older voiceprints.json entries predate this field
            s.setdefault("owner", "")      # ... and predate per-account scoping
        return loaded
    return []

def save_speakers():
    with open(DATA_FILE, "w") as f:
        json.dump(speakers, f)

speakers = load_speakers()

@app.after_request
def add_cors_headers(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,DELETE,OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type,X-Voice-Id-Secret"
    return resp

VOICE_ID_SECRET = os.environ.get("VOICE_ID_SECRET", "")

@app.before_request
def require_shared_secret():
    if not VOICE_ID_SECRET or request.method == "OPTIONS":
        return None
    if request.headers.get("X-Voice-Id-Secret") != VOICE_ID_SECRET:
        return jsonify({"error": "Unauthorized"}), 401
    return None

def request_owner():
    """The Clerk user id Meco's server attaches to every proxied call."""
    if request.method == "GET":
        return (request.args.get("owner") or "").strip()
    data = request.get_json(silent=True) or {}
    return (data.get("owner") or request.args.get("owner") or "").strip()

def owned(owner):
    return [s for s in speakers if (s.get("owner") or "") == owner]

def wav_b64_to_embedding(audio_b64):
    raw = base64.b64decode(audio_b64)
    fd, tmp_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        with open(tmp_path, "wb") as f:
            f.write(raw)
        wav = preprocess_wav(tmp_path)
        if len(wav) < MIN_USABLE_SAMPLES:
            return None
        return encoder.embed_utterance(wav)
    finally:
        os.remove(tmp_path)

def cosine(a, b):
    a = np.array(a)
    b = np.array(b)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))

def public_speaker(s):
    return {"id": s["id"], "name": s["name"], "color": s["color"], "enabled": s["enabled"], "personId": s.get("personId")}

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "speakerCount": len(speakers)})

@app.route("/speakers", methods=["GET"])
def list_speakers():
    return jsonify([public_speaker(s) for s in owned(request_owner())])

@app.route("/enroll", methods=["POST"])
def enroll():
    data = request.get_json(force=True)
    owner = request_owner()
    name = (data.get("name") or "").strip()
    person_id = (data.get("personId") or "").strip() or None
    audio_b64 = data.get("audio")
    if not name or not audio_b64:
        return jsonify({"error": "name and audio are required"}), 400

    embedding = wav_b64_to_embedding(audio_b64)
    if embedding is None:
        return jsonify({"error": "Not enough clear speech in that recording, try again closer to the mic."}), 400

    existing = None
    if person_id:
        existing = next((s for s in owned(owner) if s.get("personId") == person_id), None)
    if existing is None:
        existing = next((s for s in owned(owner) if s["name"].lower() == name.lower()), None)
    if existing is not None:
        existing["embedding"] = embedding.tolist()
        existing["name"] = name
        existing["enabled"] = True
        if person_id:
            existing["personId"] = person_id
        save_speakers()
        return jsonify(public_speaker(existing))

    new_id = max([s["id"] for s in speakers], default=0) + 1
    color = PALETTE[len(owned(owner)) % len(PALETTE)]
    record = {
        "id": new_id,
        "owner": owner,
        "personId": person_id,
        "name": name,
        "color": color,
        "embedding": embedding.tolist(),
        "enabled": True,
    }
    speakers.append(record)
    save_speakers()
    return jsonify(public_speaker(record))

@app.route("/speakers/<int:speaker_id>/reenroll", methods=["POST"])
def reenroll(speaker_id):
    data = request.get_json(force=True)
    owner = request_owner()
    audio_b64 = data.get("audio")
    sp = next((s for s in owned(owner) if s["id"] == speaker_id), None)
    if not sp:
        return jsonify({"error": "speaker not found"}), 404

    embedding = wav_b64_to_embedding(audio_b64)
    if embedding is None:
        return jsonify({"error": "Not enough clear speech in that recording, try again closer to the mic."}), 400

    sp["embedding"] = embedding.tolist()
    save_speakers()
    return jsonify({"ok": True})

@app.route("/speakers/<int:speaker_id>", methods=["DELETE"])
def delete_speaker(speaker_id):
    global speakers
    owner = request_owner()
    speakers = [s for s in speakers if not (s["id"] == speaker_id and (s.get("owner") or "") == owner)]
    save_speakers()
    return jsonify({"ok": True})

@app.route("/speakers/<int:speaker_id>/enabled", methods=["POST"])
def set_speaker_enabled(speaker_id):
    data = request.get_json(force=True)
    sp = next((s for s in owned(request_owner()) if s["id"] == speaker_id), None)
    if not sp:
        return jsonify({"error": "speaker not found"}), 404
    sp["enabled"] = bool(data.get("enabled", True))
    save_speakers()
    return jsonify({"id": sp["id"], "enabled": sp["enabled"]})

@app.route("/identify", methods=["POST"])
def identify():
    active = [s for s in owned(request_owner()) if s.get("enabled", True)]
    if not active:
        return jsonify({"scores": []})
    data = request.get_json(force=True)
    audio_b64 = data.get("audio")
    embedding = wav_b64_to_embedding(audio_b64)
    if embedding is None:
        return jsonify({"scores": []})
    scores = [
        {"id": s["id"], "name": s["name"], "personId": s.get("personId"), "score": cosine(embedding, s["embedding"])}
        for s in active
    ]
    return jsonify({"scores": scores})

if __name__ == "__main__":
    port = int(os.environ.get("PORT", os.environ.get("VOICE_ID_PORT", "8765")))
    host = "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1"
    print("Meco voice-recognition backend starting on http://%s:%d" % (host, port))
    print("%d voiceprint(s) currently stored." % len(speakers))
    app.run(host=host, port=port)
