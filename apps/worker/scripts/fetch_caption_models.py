#!/usr/bin/env python3
"""Build-time only (docker/worker.Dockerfile): downloads the two ONNX models of
the caption_layout job into CAPTION_MODELS_DIR and refuses any file whose
SHA-256 is not the one pinned here. Never run by the worker itself."""

import hashlib, os, urllib.request
base = "https://github.com/opencv/opencv_zoo/raw/main/models/"
models = {
    "face_detection_yunet_2023mar.onnx": (
        base + "face_detection_yunet/face_detection_yunet_2023mar.onnx",
        "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    ),
    "text_detection_en_ppocrv3_2023may.onnx": (
        base + "text_detection_ppocr/text_detection_en_ppocrv3_2023may.onnx",
        "03f550c6b406fda8bf54bd8327815f6c7e2edd98cea02348c93d879254366587",
    ),
}
target = os.environ["CAPTION_MODELS_DIR"]
os.makedirs(target, exist_ok=True)
for name, (url, digest) in models.items():
    data = urllib.request.urlopen(url, timeout=120).read()
    if hashlib.sha256(data).hexdigest() != digest:
        raise SystemExit(f"{name}: checksum mismatch")
    with open(os.path.join(target, name), "wb") as handle:
        handle.write(data)
