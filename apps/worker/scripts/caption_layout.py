#!/usr/bin/env python3
"""Measures, for each caption cue of a video, how busy the three places a
caption can sit are: top, middle and bottom. Prints one JSON object.

Faces come from YuNet and written text from the PP-OCRv3 text detector (the
detection half of PaddleOCR only: boxes, never the words), both ONNX models
run by OpenCV on CPU. A face counts three times as much as text: covering a
face is worse than covering a sign.

What leaves this process is three numbers per cue (the share of each band that
is covered, weighted). No box, no face, no frame and no crop is printed or
written anywhere: this is face *detection*, and it stays inside the process.
`apps/worker/src/jobs/caption-layout.ts` turns the numbers into one zone per
cue, and only the zones are kept.
"""

import argparse
import json
import os
import sys

import cv2
import numpy as np

# Where a caption band sits, as a share of the frame's height (top, middle, bottom).
BANDS = ((0.04, 0.30), (0.375, 0.625), (0.70, 0.96))
FACE_WEIGHT = 3.0
TEXT_WEIGHT = 1.0
ANALYSIS_WIDTH = 640
MAX_SAMPLES_PER_CUE = 6


def sample_times(start, end):
    """A few instants inside the cue: its middle, its ends, and one every 2 s of a long one."""
    length = max(0.0, end - start)
    if length <= 1.5:
        return [start + length / 2]
    times = [start + 0.25, start + length / 2, end - 0.25]
    step = 2.0
    t = start + step
    while t < end - 0.25 and len(times) < MAX_SAMPLES_PER_CUE:
        times.append(t)
        t += step
    return sorted(times)[:MAX_SAMPLES_PER_CUE]


def band_cover(boxes, height, width):
    """Share of each band's area the boxes cover (their union, per band, capped at 1)."""
    covers = []
    for top, bottom in BANDS:
        y0, y1 = int(top * height), int(bottom * height)
        mask = np.zeros((max(1, y1 - y0), width), dtype=np.uint8)
        for x, y, w, h in boxes:
            bx0, bx1 = max(0, int(x)), min(width, int(x + w))
            by0, by1 = max(y0, int(y)), min(y1, int(y + h))
            if bx1 > bx0 and by1 > by0:
                mask[by0 - y0 : by1 - y0, bx0:bx1] = 1
        covers.append(float(mask.mean()))
    return covers


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", help="local path to the video")
    parser.add_argument("cues", help="local path to a JSON list of [start, end] in seconds")
    parser.add_argument("--models", default=os.environ.get("CAPTION_MODELS_DIR", "/opt/wings-worker-models/captions"))
    parser.add_argument("--threads", type=int, default=1)
    args = parser.parse_args()

    cv2.setNumThreads(max(1, args.threads))
    with open(args.cues, encoding="utf-8") as handle:
        cues = json.load(handle)

    capture = cv2.VideoCapture(args.input)
    if not capture.isOpened():
        print(json.dumps({"error": "undecodable"}))
        return 3
    source_w = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    source_h = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if source_w <= 0 or source_h <= 0:
        print(json.dumps({"error": "undecodable"}))
        return 3
    scale = min(1.0, ANALYSIS_WIDTH / source_w)
    width, height = max(1, round(source_w * scale)), max(1, round(source_h * scale))

    faces = cv2.FaceDetectorYN.create(
        os.path.join(args.models, "face_detection_yunet_2023mar.onnx"), "", (width, height), 0.8, 0.3, 5000
    )
    text = cv2.dnn_TextDetectionModel_DB(os.path.join(args.models, "text_detection_en_ppocrv3_2023may.onnx"))
    text.setBinaryThreshold(0.3).setPolygonThreshold(0.5).setMaxCandidates(200).setUnclipRatio(2.0)
    # The detector takes sides that are multiples of 32.
    text_size = (max(32, (width // 32) * 32), max(32, (height // 32) * 32))
    text.setInputParams(1.0 / 255.0, text_size, (122.67891434, 116.66876762, 104.00698793), True)

    frames = 0
    result = []
    for start, end in cues:
        worst = [0.0, 0.0, 0.0]
        for t in sample_times(float(start), float(end)):
            capture.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
            ok, frame = capture.read()
            if not ok or frame is None:
                continue
            frames += 1
            if scale != 1.0:
                frame = cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA)
            _, found = faces.detect(frame)
            face_boxes = []
            for row in found if found is not None else []:
                x, y, w, h = row[:4]
                # The face box stops at the chin; a caption over the mouth or the neck is just as bad.
                face_boxes.append((x - w * 0.15, y - h * 0.15, w * 1.3, h * 1.8))
            text_boxes = []
            polygons, _ = text.detect(cv2.resize(frame, text_size))
            sx, sy = width / text_size[0], height / text_size[1]
            for polygon in polygons:
                xs = [point[0] * sx for point in polygon]
                ys = [point[1] * sy for point in polygon]
                text_boxes.append((min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)))
            face_cover = band_cover(face_boxes, height, width)
            text_cover = band_cover(text_boxes, height, width)
            for band in range(3):
                cost = FACE_WEIGHT * face_cover[band] + TEXT_WEIGHT * text_cover[band]
                worst[band] = max(worst[band], cost)
        result.append([round(value, 4) for value in worst])
    capture.release()

    json.dump({"width": source_w, "height": source_h, "frames": frames, "costs": result}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
