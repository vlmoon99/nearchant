"""Run in the image: docker run --rm nearchant/tts:dev sh -c 'pip install -q pytest httpx && pytest -q'"""
import os

os.environ.setdefault("API_KEY", "k")
os.environ["KOKORO_ONNX"] = "/nonexistent.onnx"  # no weights in the test: the failure paths
os.environ["WHISPER_MODEL_DIR"] = "/nonexistent"

import numpy as np
from fastapi.testclient import TestClient

import app
import polish

client = TestClient(app.app)
AUTH = {"authorization": "Bearer k"}


def test_auth_required_except_health():
    assert client.post("/generate", json={"text": "hi"}).status_code == 401
    assert client.get("/health").status_code == 200


def test_english_only_and_bounded():
    assert client.post("/generate", json={"text": "привіт", "lang": "uk"}, headers=AUTH).status_code == 422
    assert client.post("/generate", json={"text": ""}, headers=AUTH).status_code == 422
    assert client.post("/generate", json={"text": "x" * 5000}, headers=AUTH).status_code == 422


def test_missing_model_is_502_and_health_says_not_loaded(tmp_path, monkeypatch):
    monkeypatch.setattr(app, "ASSETS_DIR", tmp_path)
    assert client.post("/generate", json={"text": "hi"}, headers=AUTH).status_code == 502
    h = client.get("/health").json()
    assert h["loaded"] is False and h["capabilities"]["langs"] == []


def test_transcribe_missing_file_and_missing_model(tmp_path, monkeypatch):
    monkeypatch.setattr(app, "ASSETS_DIR", tmp_path)
    assert client.post("/transcribe", json={"path": "../etc/passwd"}, headers=AUTH).status_code == 404
    (tmp_path / "a.wav").write_bytes(b"RIFF")
    assert client.post("/transcribe", json={"path": "a.wav"}, headers=AUTH).status_code == 503


def test_polish_keeps_length_and_peak_under_ceiling():
    sr = 24000
    x = (0.5 * np.sin(np.linspace(0, 2000, sr))).astype(np.float32)
    y = polish.polish(x, sr, "natural")
    assert len(y) == len(x) and float(np.max(np.abs(y))) <= 10 ** (-1 / 20) + 1e-6
    assert polish.polish(x, sr, "off") is x
