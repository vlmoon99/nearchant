"""Run in the image: docker run --rm -e API_KEY=k nearchant/video:dev sh -c 'pip install -q pytest && pytest -q'"""
import os

os.environ.setdefault("API_KEY", "k")
os.environ["COMFY_URL"] = "http://127.0.0.1:9"  # nothing listens: the failure path

from fastapi.testclient import TestClient

import app

client = TestClient(app.app)
AUTH = {"authorization": "Bearer k"}


def test_build_substitutes_every_token_and_pins_encoder_device():
    req = app.GenerateRequest(prompt="a mug", product_id="p1", seed=7)
    wf = app.build_workflow(req, "hero.png")
    text = str(wf)
    assert "__" not in text.replace("__init__", "")
    nodes = {n["class_type"]: n["inputs"] for n in wf.values()}
    assert nodes["EmptyLTXVLatentVideo"]["width"] == 352 and nodes["EmptyLTXVLatentVideo"]["height"] == 640
    assert nodes["LoadImage"]["image"] == "hero.png"
    assert nodes["CLIPLoader"]["device"] == app.LTX_TEXT_ENCODER_DEVICE
    seeds = [n["inputs"]["noise_seed"] for n in wf.values() if n["class_type"] == "RandomNoise"]
    assert 7 in seeds  # stage 1; the refine stage keeps the template's fixed seed


def test_t2v_when_no_image():
    wf = app.build_workflow(app.GenerateRequest(prompt="x"), None)
    assert not any(n["class_type"] == "LoadImage" for n in wf.values())


def test_auth_required_except_health():
    assert client.post("/generate", json={"prompt": "x"}).status_code == 401
    assert client.post("/generate", json={"prompt": "x"}, headers={"authorization": "Bearer nope"}).status_code == 401
    assert client.get("/health").status_code == 200


def test_bad_inputs_rejected():
    assert client.post("/generate", json={"prompt": "x", "width": 700}, headers=AUTH).status_code == 422
    assert client.post("/generate", json={"prompt": "x", "product_id": "../x"}, headers=AUTH).status_code == 422
    assert client.post("/generate", json={"prompt": "x", "model": "14b"}, headers=AUTH).status_code == 422
    r = client.post("/generate", json={"prompt": "x", "ref_image_b64": "!!"}, headers=AUTH)
    assert r.status_code == 422


def test_comfy_down_is_503_not_hang(tmp_path, monkeypatch):
    monkeypatch.setattr(app, "ASSETS_DIR", tmp_path)
    monkeypatch.setattr(app.asyncio, "sleep", _nosleep)
    r = client.post("/generate", json={"prompt": "x"}, headers=AUTH)
    assert r.status_code == 503
    assert client.get("/health").json()["loaded"] is False


def test_files_cannot_escape_assets():
    assert client.get("/files/../../etc/passwd", headers=AUTH).status_code == 404


async def _nosleep(_s):
    return None
