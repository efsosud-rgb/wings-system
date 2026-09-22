#!/usr/bin/env python3
"""Transcribes one local audio/video file with faster-whisper and prints JSON
to stdout.

Runs the "small" model on CPU. This is the whole contract with the Node side:
read the file it is given, print one JSON object, exit. It never talks to
Postgres or to storage — `apps/worker/src/jobs/transcribe.ts` owns the queue
row and the upload of the result back to the Drive.
"""

import argparse
import json
import sys

from faster_whisper import WhisperModel


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", help="local path to the audio/video file")
    parser.add_argument(
        "--language", default=None, help="ISO 639-1 code; auto-detected when omitted"
    )
    parser.add_argument(
        "--threads", type=int, default=1, help="CPU threads for this one transcription"
    )
    args = parser.parse_args()

    model = WhisperModel(
        "small", device="cpu", compute_type="int8", cpu_threads=max(1, args.threads)
    )
    segments, info = model.transcribe(args.input, language=args.language, vad_filter=True)

    result = {
        "language": info.language,
        "languageProbability": info.language_probability,
        "durationSeconds": info.duration,
        "segments": [
            {"start": segment.start, "end": segment.end, "text": segment.text.strip()}
            for segment in segments
        ],
    }
    json.dump(result, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
