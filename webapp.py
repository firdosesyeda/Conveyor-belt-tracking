from __future__ import annotations

import math
import json
import os
import subprocess
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import cv2
import imageio_ffmpeg
import numpy as np
from flask import Flask, jsonify, render_template, request, send_file
from ultralytics import YOLO
from werkzeug.utils import secure_filename


ROOT = Path(__file__).resolve().parent
STORE_DIR = ROOT / "webapp_data"
UPLOAD_DIR = STORE_DIR / "uploads"
OUTPUT_DIR = STORE_DIR / "outputs"
SMALL_OBJECT_MODEL = (
    ROOT / "runs" / "detect" / "yolo26n-conveyor-small-objects" / "weights" / "best.pt"
)
TRAINED_MODEL = (
    ROOT / "runs" / "detect" / "yolo26n-conveyor-products" / "weights" / "best.pt"
)
DEFAULT_MODEL = SMALL_OBJECT_MODEL if SMALL_OBJECT_MODEL.is_file() else TRAINED_MODEL
MODEL_PATH = Path(os.environ.get("YOLO_MODEL", str(DEFAULT_MODEL))).expanduser()
ALLOWED_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}
CONFIDENCE = float(os.environ.get("YOLO_CONFIDENCE", "0.12"))

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


def point_in_polygon(x: float, y: float, polygon: list[list[float]]) -> bool:
    inside = False
    previous = len(polygon) - 1
    for current in range(len(polygon)):
        x1, y1 = polygon[current]
        x2, y2 = polygon[previous]
        if (y1 > y) != (y2 > y):
            crossing_x = (x2 - x1) * (y - y1) / (y2 - y1 + 1e-12) + x1
            if x < crossing_x:
                inside = not inside
        previous = current
    return inside


def analyze_video(
    job_id: str,
    input_path: Path,
    output_path: Path,
    zones: list[dict[str, Any]],
    inference_size: int,
) -> None:
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
        zone_counts = {zone["id"]: 0 for zone in zones}
        zone_track_ids = {zone["id"]: set() for zone in zones}
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
                tracker=str(ROOT / "bytetrack-small.yaml"),
                conf=CONFIDENCE,
                imgsz=inference_size,
                verbose=False,
            )[0]
            boxes = prediction.boxes
            ids = boxes.id.int().cpu().tolist() if boxes.id is not None else []
            classes = boxes.cls.int().cpu().tolist() if boxes.cls is not None else []
            confidences = boxes.conf.cpu().tolist() if boxes.conf is not None else []
            coordinates = boxes.xyxy.cpu().tolist() if boxes.xyxy is not None else []
            # Only retain detections whose center lies inside a user-drawn zone.
            # ByteTrack still sees the full frame, preserving IDs as products
            # approach and leave the counting area.
            zone_detection_indices = []
            for detection_index, (x1, y1, x2, y2) in enumerate(coordinates):
                center_x = ((x1 + x2) / 2) / width
                center_y = ((y1 + y2) / 2) / height
                if any(point_in_polygon(center_x, center_y, zone["points"]) for zone in zones):
                    zone_detection_indices.append(detection_index)
            timestamp = (frame_index - 1) / fps
            second = int(timestamp)
            bucket = timeline.setdefault(second, {"new_tracks": 0, "detections": 0, "active": 0})
            total_detections += len(zone_detection_indices)
            bucket["detections"] += len(zone_detection_indices)

            active_ids: set[int] = set()
            for index in zone_detection_indices:
                if index >= len(ids):
                    continue
                track_id = ids[index]
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
                        "zones_entered": set(),
                    }
                    tracks[track_id] = track
                    bucket["new_tracks"] += 1
                track["last_frame"] = frame_index
                track["detections"] += 1
                track["confidence_sum"] += confidence
                if index < len(coordinates):
                    x1, y1, x2, y2 = coordinates[index]
                    center_x = ((x1 + x2) / 2) / width
                    center_y = ((y1 + y2) / 2) / height
                    for zone in zones:
                        zone_id = zone["id"]
                        if (
                            zone_id not in track["zones_entered"]
                            and point_in_polygon(center_x, center_y, zone["points"])
                        ):
                            track["zones_entered"].add(zone_id)
                            zone_counts[zone_id] += 1
                            zone_track_ids[zone_id].add(track_id)

            bucket["active"] = max(bucket["active"], len(active_ids))
            max_simultaneous = max(max_simultaneous, len(active_ids))
            zone_prediction = prediction[zone_detection_indices]
            annotated = zone_prediction.plot()
            if zones:
                overlay = annotated.copy()
                zone_colors = [(61, 177, 126), (220, 157, 77), (151, 128, 202), (76, 158, 211), (202, 112, 120), (102, 177, 182)]
                pixel_polygons = []
                for zone_index, zone in enumerate(zones):
                    color = zone_colors[zone_index % len(zone_colors)]
                    polygon = [
                        (int(point[0] * width), int(point[1] * height))
                        for point in zone["points"]
                    ]
                    pixel_polygons.append((zone, color, polygon))
                    cv2.fillPoly(overlay, [np.array(polygon, dtype="int32")], color)
                cv2.addWeighted(overlay, 0.12, annotated, 0.88, 0, annotated)
                for zone, color, polygon in pixel_polygons:
                    cv2.polylines(
                        annotated,
                        [np.array(polygon, dtype="int32")],
                        True,
                        color,
                        max(2, round(min(width, height) / 360)),
                        cv2.LINE_AA,
                    )
                    label_x = max(4, min(point[0] for point in polygon))
                    label_y = max(22, min(point[1] for point in polygon) - 8)
                    label = f"{zone['name']}: {zone_counts[zone['id']]}"
                    (label_width, label_height), _ = cv2.getTextSize(
                        label, cv2.FONT_HERSHEY_SIMPLEX, 0.65, 2
                    )
                    cv2.rectangle(
                        annotated,
                        (label_x, label_y - label_height - 8),
                        (label_x + label_width + 12, label_y + 4),
                        color,
                        -1,
                    )
                    cv2.putText(
                        annotated,
                        label,
                        (label_x + 6, label_y - 2),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.65,
                        (255, 255, 255),
                        2,
                        cv2.LINE_AA,
                    )
            writer.write(annotated)

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
                "zones": sorted(track["zones_entered"]),
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
            "zones": [
                {
                    "id": zone["id"],
                    "name": zone["name"],
                    "count": zone_counts[zone["id"]],
                    "track_ids": sorted(zone_track_ids[zone["id"]]),
                }
                for zone in zones
            ],
            "timeline": [
                {"second": second, **timeline[second]}
                for second in range(max(timeline.keys(), default=-1) + 1)
            ],
            "tracks": sorted(track_rows, key=lambda item: item["id"]),
        }
        writer.release()
        writer = None
        # OpenCV's mp4v output is not reliably playable in browsers. Re-encode
        # the annotated file as H.264 with a browser-compatible pixel format.
        browser_output = output_path.with_name(f"{output_path.stem}_h264.mp4")
        subprocess.run(
            [
                imageio_ffmpeg.get_ffmpeg_exe(),
                "-y",
                "-i",
                str(output_path),
                "-an",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                str(browser_output),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        browser_output.replace(output_path)
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

    try:
        requested_zones = json.loads(request.form.get("zones", "[]"))
        inference_size = int(request.form.get("imgsz", "1280"))
    except (TypeError, ValueError, json.JSONDecodeError):
        return jsonify(error="Invalid zone or image-size settings."), 400
    if not isinstance(requested_zones, list) or len(requested_zones) > 12:
        return jsonify(error="Create up to 12 counting zones."), 400
    if inference_size not in {640, 960, 1280}:
        return jsonify(error="Choose an inference size of 640, 960, or 1280."), 400

    zones = []
    for index, raw_zone in enumerate(requested_zones):
        if not isinstance(raw_zone, dict):
            return jsonify(error=f"Zone {index + 1} is invalid."), 400
        raw_points = raw_zone.get("points", [])
        if not isinstance(raw_points, list) or len(raw_points) < 3:
            return jsonify(error=f"Zone {index + 1} needs at least three points."), 400
        points = []
        try:
            for point in raw_points:
                x, y = float(point["x"]), float(point["y"])
                if not (0 <= x <= 1 and 0 <= y <= 1):
                    raise ValueError
                points.append([x, y])
        except (KeyError, TypeError, ValueError, IndexError):
            return jsonify(error=f"Zone {index + 1} has an invalid point."), 400
        zone_name = str(raw_zone.get("name", f"Zone {index + 1}"))[:32].strip()
        zones.append({"id": str(raw_zone.get("id", f"zone-{index + 1}")), "name": zone_name or f"Zone {index + 1}", "points": points})

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
    executor.submit(analyze_video, job_id, input_path, output_path, zones, inference_size)
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
