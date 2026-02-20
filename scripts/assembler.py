"""
Sprite sheet assembly — arranges generated pose images into a grid
and exports as a single PNG sprite sheet.
"""

import math
from PIL import Image
from dataclasses import dataclass

from scripts.generator import GeneratedPose


@dataclass
class SpriteSheet:
    """Assembled sprite sheet with metadata."""
    image: Image.Image
    metadata: list[dict]
    frame_size: int
    columns: int
    rows: int
    total_frames: int


# Animation presets — common pose combinations for different game needs
ANIMATION_PRESETS = {
    "minimal": ["idle", "walk_1", "attack_1", "death"],
    "basic": ["idle", "walk_1", "walk_2", "attack_1", "jump", "death"],
    "full": [
        "idle", "walk_1", "walk_2", "run_1", "run_2",
        "attack_1", "attack_2", "jump", "fall",
        "hurt", "death", "block",
    ],
}


def assemble(
    poses: list[GeneratedPose],
    frame_size: int = 64,
    padding: int = 1,
    columns: int | None = None,
) -> SpriteSheet:
    """Assemble individual pose images into a sprite sheet.

    Args:
        poses: List of generated poses to arrange.
        frame_size: Output size of each frame in pixels (32, 64, 96, 128).
        padding: Pixels of transparent padding between frames.
        columns: Number of columns. None = auto (max 8).

    Returns:
        SpriteSheet with the assembled image and frame metadata.
    """
    n_frames = len(poses)
    if n_frames == 0:
        raise ValueError("No poses to assemble")

    if columns is None:
        columns = min(n_frames, 8)
    rows = math.ceil(n_frames / columns)

    cell_size = frame_size + (padding * 2)
    sheet_width = columns * cell_size
    sheet_height = rows * cell_size

    # Create transparent sheet
    sheet = Image.new("RGBA", (sheet_width, sheet_height), (0, 0, 0, 0))
    frame_metadata = []

    for i, pose in enumerate(poses):
        row = i // columns
        col = i % columns
        x = col * cell_size + padding
        y = row * cell_size + padding

        # Detect if pixel art for appropriate resampling
        resampling = Image.NEAREST if _is_pixel_art(pose.image) else Image.LANCZOS

        # Resize pose to target frame size
        resized = pose.image.resize((frame_size, frame_size), resampling)
        sheet.paste(resized, (x, y), resized)

        frame_metadata.append({
            "name": pose.pose_name,
            "x": x,
            "y": y,
            "width": frame_size,
            "height": frame_size,
            "index": i,
            "seed": pose.seed,
        })

    return SpriteSheet(
        image=sheet,
        metadata=frame_metadata,
        frame_size=frame_size,
        columns=columns,
        rows=rows,
        total_frames=n_frames,
    )


def _is_pixel_art(image: Image.Image) -> bool:
    """Heuristic: check if image appears to be pixel art."""
    import numpy as np
    small = image.convert("RGB").resize((32, 32), Image.NEAREST)
    arr = np.array(small).reshape(-1, 3)
    unique = len(np.unique(arr, axis=0))
    return unique < 32
