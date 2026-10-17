from __future__ import annotations

import math
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import cv2
from flask import Flask, jsonify, render_template, request, send_file
from ultralytics import YOLO
from werkzeug.utils import secure_filename


ROOT = Path(__file__).resolve().parent
STORE_DIR = ROOT / "webapp_data"
UPLOAD_DIR = STORE_DIR / "uploads"
OUTPUT_DIR = STORE_DIR / "outputs"
DEFAULT_MODEL = (
    ROOT / "runs" / "detect" / "yolo26n-conveyor-products" / "weights" / "best.pt"
)
MODEL_PATH = Path(os.environ.get("YOLO_MODEL", str(DEFAULT_MODEL))).expanduser()
ALLOWED_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}
CONFIDENCE = float(os.environ.get("YOLO_CONFIDENCE", "0.25"))

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024 * 1024  # 2 GB
jobs: dict[str, dict[str, Any]] = {}
jobs_lock = threading.Lock()
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="video-analysis")


def update_job(job_id: str, **updates: Any) -> None:
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].update(updates)


def analyze_video(job_id: str, input_path: Path, output_path: Path) -> None:
    capture = cv2.VideoCapture(str(input_path))
    writer: cv2.VideoWriter | None = None
    try:
        if not capture.isOpened():
            raise ValueError("The uploaded file could not be opened as a video.")

        fps = float(capture.get(cv2.CAP_PROP_FPS))
        if not math.isfinite(fps) or fps <= 0:
            fps = 30.0
        total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        if width <= 0 or height <= 0:
            raise ValueError("The uploaded video has invalid frame dimensions.")

        writer = cv2.VideoWriter(
            str(output_path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height)
        )
        if not writer.isOpened():
            raise RuntimeError("Could not create the annotated MP4 video on this system.")

        if not MODEL_PATH.is_file():
            raise FileNotFoundError(
                f"Trained model not found at {MODEL_PATH}. Run train_model.py first, "
                "or set the YOLO_MODEL environment variable to a .pt checkpoint."
            )

        update_job(job_id, state="processing", progress=0, message="Loading detector")
        model = YOLO(str(MODEL_PATH))
        tracks: dict[int, dict[str, Any]] = {}
        timeline: dict[int, dict[str, int]] = {}
        total_detections = 0
        max_simultaneous = 0
        frame_index = 0

        while True:
            ok, frame = capture.read()
            if not ok:
                break
            frame_index += 1

            prediction = model.track(
                frame,
                persist=True,
                tracker="bytetrack.yaml",
                conf=CONFIDENCE,
                imgsz=640,
                verbose=False,
            )[0]
            boxes = prediction.boxes
            ids = boxes.id.int().cpu().tolist() if boxes.id is not None else []
            classes = boxes.cls.int().cpu().tolist() if boxes.cls is not None else []
            confidences = boxes.conf.cpu().tolist() if boxes.conf is not None else []
            timestamp = (frame_index - 1) / fps
            second = int(timestamp)
            bucket = timeline.setdefault(second, {"new_tracks": 0, "detections": 0, "active": 0})
            total_detections += len(confidences)
            bucket["detections"] += len(confidences)

            active_ids: set[int] = set()
            for index, track_id in enumerate(ids):
                active_ids.add(track_id)
                class_id = classes[index] if index < len(classes) else -1
                confidence = float(confidences[index]) if index < len(confidences) else 0.0
                class_name = model.names.get(class_id, str(class_id))
                track = tracks.get(track_id)
                if track is None:
                    track = {
                        "id": track_id,
                        "class": class_name,
                        "first_frame": frame_index,
                        "last_frame": frame_index,
                        "detections": 0,
                        "confidence_sum": 0.0,
                    }
                    tracks[track_id] = track
                    bucket["new_tracks"] += 1
                track["last_frame"] = frame_index
                track["detections"] += 1
                track["confidence_sum"] += confidence

            bucket["active"] = max(bucket["active"], len(active_ids))
            max_simultaneous = max(max_simultaneous, len(active_ids))
            writer.write(prediction.plot())

            if frame_index % 5 == 0:
                progress = min(99, int(frame_index * 100 / total_frames)) if total_frames else 0
                update_job(
                    job_id,
                    progress=progress,
                    message=f"Tracking frame {frame_index:,}"
                    + (f" of {total_frames:,}" if total_frames else ""),
                    frames_processed=frame_index,
                )

        if frame_index == 0:
            raise ValueError("The video contains no readable frames.")

        duration = frame_index / fps
        track_rows = []
        class_counts: dict[str, int] = {}
        for track in tracks.values():
            elapsed = max(1 / fps, (track["last_frame"] - track["first_frame"]) / fps)
            row = {
                "id": track["id"],
                "class": track["class"],
                "detections": track["detections"],
                "confidence": round(track["confidence_sum"] / track["detections"], 4),
                "duration_seconds": round(elapsed, 2),
                "first_seen_seconds": round((track["first_frame"] - 1) / fps, 2),
            }
            track_rows.append(row)
            class_counts[track["class"]] = class_counts.get(track["class"], 0) + 1

        avg_confidence = (
            sum(item["confidence"] * item["detections"] for item in track_rows)
            / sum(item["detections"] for item in track_rows)
            if track_rows
            else 0.0
        )
        average_track_seconds = (
            sum(item["duration_seconds"] for item in track_rows) / len(track_rows)
            if track_rows
            else 0.0
        )
        analytics = {
            "total_products": len(tracks),
            "total_detections": total_detections,
            "max_simultaneous": max_simultaneous,
            "avg_confidence": round(avg_confidence, 4),
            "avg_track_seconds": round(average_track_seconds, 2),
            "throughput_per_minute": round(len(tracks) / (duration / 60), 2)
            if duration > 0
            else 0,
            "video_duration_seconds": round(duration, 2),
            "video_fps": round(fps, 2),
            "processed_frames": frame_index,
            "class_breakdown": class_counts,
            "timeline": [
                {"second": second, **timeline[second]}
                for second in range(max(timeline.keys(), default=-1) + 1)
            ],
            "tracks": sorted(track_rows, key=lambda item: item["id"]),
        }
        writer.release()
        writer = None
        update_job(
            job_id,
            state="complete",
            progress=100,
            message="Analysis complete",
            frames_processed=frame_index,
            analytics=analytics,
            # This worker runs outside Flask's request context, so keep the
            # local endpoint as a plain path instead of calling url_for here.
            video_url=f"/api/jobs/{job_id}/video",
        )
    except Exception as exc:  # The message is surfaced in the local UI for the user.
        update_job(job_id, state="error", message=str(exc))
    finally:
        capture.release()
        if writer is not None:
            writer.release()


@app.get("/")
def index():
    return render_template("index.html", model_name=MODEL_PATH.name)


@app.post("/api/analyze")
def start_analysis():
    upload = request.files.get("video")
    if upload is None or not upload.filename:
        return jsonify(error="Choose a video file to analyze."), 400

    extension = Path(upload.filename).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        return jsonify(error="Use an MP4, MOV, AVI, MKV, WEBM, or M4V video."), 400

    safe_name = secure_filename(upload.filename) or "conveyor-video.mp4"
    job_id = uuid.uuid4().hex
    input_path = UPLOAD_DIR / f"{job_id}_{safe_name}"
    output_path = OUTPUT_DIR / f"{job_id}_tracked.mp4"
    upload.save(input_path)

    job = {
        "id": job_id,
        "filename": safe_name,
        "state": "queued",
        "progress": 0,
        "message": "Queued for analysis",
        "frames_processed": 0,
    }
    with jobs_lock:
        jobs[job_id] = job
    executor.submit(analyze_video, job_id, input_path, output_path)
    return jsonify(job), 202


@app.get("/api/jobs/<job_id>")
def get_job(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            return jsonify(error="Analysis job not found. Restart the upload."), 404
        return jsonify(job)


@app.get("/api/jobs/<job_id>/video")
def get_video(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None or job.get("state") != "complete":
            return jsonify(error="Tracked video is not ready."), 404
    output_path = OUTPUT_DIR / f"{job_id}_tracked.mp4"
    if not output_path.is_file():
        return jsonify(error="Tracked video file is missing."), 404
    return send_file(output_path, mimetype="video/mp4", conditional=True)


@app.errorhandler(413)
def too_large(_error):
    return jsonify(error="Video is larger than the 2 GB upload limit."), 413


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
