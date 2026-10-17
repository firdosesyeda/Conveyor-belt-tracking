from pathlib import Path

import torch
from ultralytics import YOLO


ROOT = Path(__file__).resolve().parent
DATA_YAML = ROOT / "data.yaml"
WEIGHTS = ROOT / "yolo26n.pt"
RUNS_DIR = ROOT / "runs" / "detect"


def main() -> None:
    if not DATA_YAML.is_file():
        raise FileNotFoundError(f"Dataset config not found: {DATA_YAML}")

    # Use the local pretrained weights when present; otherwise Ultralytics
    # downloads yolo26n.pt on the first run.
    model = YOLO(str(WEIGHTS) if WEIGHTS.is_file() else "yolo26n.pt")
    device = 0 if torch.cuda.is_available() else "cpu"

    train_results = model.train(
        data=str(DATA_YAML),
        epochs=20,
        imgsz=640,
        batch=8,
        device=device,
        workers=0,  # Safe default for Windows.
        patience=20,
        project=str(RUNS_DIR),
        name="yolo26n-conveyor-products",
        exist_ok=True,
    )

    best_weights = Path(train_results.save_dir) / "weights" / "best.pt"
    print(f"Best model: {best_weights}")

    # Evaluate the finished model on the held-out test split.
    test_model = YOLO(str(best_weights))
    test_model.val(data=str(DATA_YAML), split="test", device=device)


if __name__ == "__main__":
    main()
