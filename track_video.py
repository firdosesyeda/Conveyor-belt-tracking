import argparse
from pathlib import Path

from ultralytics import YOLO


ROOT = Path(__file__).resolve().parent
DEFAULT_WEIGHTS = (
    ROOT / "runs" / "detect" / "yolo26n-conveyor-products" / "weights" / "best.pt"
)
DEFAULT_VIDEO = Path(r"C:\Users\Firdose\Downloads\6447409-hd_1920_1080_30fps.mp4")


def main() -> None:
    parser = argparse.ArgumentParser(description="Track conveyor products in a video.")
    parser.add_argument("video", nargs="?", type=Path, default=DEFAULT_VIDEO)
    parser.add_argument("--weights", type=Path, default=DEFAULT_WEIGHTS)
    parser.add_argument("--conf", type=float, default=0.25)
    args = parser.parse_args()

    if not args.weights.is_file():
        raise FileNotFoundError(
            f"Model not found: {args.weights}. Run train_model.py first."
        )
    if not args.video.is_file():
        raise FileNotFoundError(f"Video not found: {args.video}")

    model = YOLO(str(args.weights))
    model.track(
        source=str(args.video),
        tracker="bytetrack.yaml",
        conf=args.conf,
        save=True,
        project=str(ROOT / "runs" / "track"),
        name=args.video.stem,
        exist_ok=True,
    )


if __name__ == "__main__":
    main()
