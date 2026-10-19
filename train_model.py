from pathlib import Path

import torch
from ultralytics import YOLO


ROOT = Path(__file__).resolve().parent
DATA_YAML = ROOT / "data.yaml"
RUNS_DIR = ROOT / "runs" / "detect"
PREVIOUS_BEST = RUNS_DIR / "yolo26n-conveyor-products" / "weights" / "best.pt"
PRETRAINED = ROOT / "yolo26n.pt"


def main() -> None:
    if not DATA_YAML.is_file():
        raise FileNotFoundError(f"Dataset config not found: {DATA_YAML}")

    # Fine-tune the trained conveyor model when present; otherwise start from
    # the local YOLO26n pretrained checkpoint.
    initial_weights = PREVIOUS_BEST if PREVIOUS_BEST.is_file() else PRETRAINED
    model = YOLO(str(initial_weights) if initial_weights.is_file() else "yolo26n.pt")
    device = 0 if torch.cuda.is_available() else "cpu"

    train_results = model.train(
        data=str(DATA_YAML),
        epochs=20,
        imgsz=960,
        batch=4,
        device=device,
        workers=0,  # Safe default for Windows.
        patience=20,
        mosaic=0.7,
        close_mosaic=5,
        scale=0.25,
        translate=0.05,
        project=str(RUNS_DIR),
        name="yolo26n-conveyor-small-objects",
        exist_ok=True,
    )

    best_weights = Path(train_results.save_dir) / "weights" / "best.pt"
    print(f"Best model: {best_weights}")

    # Evaluate the finished model on the held-out test split.
    test_model = YOLO(str(best_weights))
    test_model.val(data=str(DATA_YAML), split="test", device=device)


if __name__ == "__main__":
    main()
