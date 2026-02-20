"""
Export formats — generates engine-specific metadata files
alongside the sprite sheet PNG.
"""

import json
import os
import zipfile
from io import BytesIO
from PIL import Image

from scripts.assembler import SpriteSheet
from scripts.generator import GeneratedPose


def export_generic(sheet: SpriteSheet, name: str) -> dict[str, bytes]:
    """Export as PNG + JSON metadata (works with any engine)."""
    exports = {}
    exports[f"{name}_spritesheet.png"] = _image_to_bytes(sheet.image)
    exports[f"{name}_metadata.json"] = json.dumps({
        "frames": sheet.metadata,
        "meta": {
            "size": {"w": sheet.image.width, "h": sheet.image.height},
            "frame_size": sheet.frame_size,
            "columns": sheet.columns,
            "rows": sheet.rows,
            "total_frames": sheet.total_frames,
        }
    }, indent=2).encode()
    return exports


def export_phaser(sheet: SpriteSheet, name: str) -> dict[str, bytes]:
    """Export as Phaser 3 JSON Atlas format."""
    exports = {}
    exports[f"{name}_spritesheet.png"] = _image_to_bytes(sheet.image)

    atlas = {
        "frames": {},
        "meta": {
            "app": "SpriteForge",
            "version": "1.0",
            "image": f"{name}_spritesheet.png",
            "format": "RGBA8888",
            "size": {"w": sheet.image.width, "h": sheet.image.height},
            "scale": "1",
        }
    }
    for frame in sheet.metadata:
        atlas["frames"][frame["name"]] = {
            "frame": {
                "x": frame["x"],
                "y": frame["y"],
                "w": frame["width"],
                "h": frame["height"],
            },
            "rotated": False,
            "trimmed": False,
            "spriteSourceSize": {
                "x": 0, "y": 0,
                "w": frame["width"], "h": frame["height"],
            },
            "sourceSize": {
                "w": frame["width"], "h": frame["height"],
            },
        }

    exports[f"{name}_atlas.json"] = json.dumps(atlas, indent=2).encode()
    return exports


def export_godot(sheet: SpriteSheet, name: str) -> dict[str, bytes]:
    """Export as Godot 4 SpriteFrames .tres resource."""
    exports = {}
    exports[f"{name}_spritesheet.png"] = _image_to_bytes(sheet.image)

    tres_lines = [
        '[gd_resource type="SpriteFrames" format=3]',
        "",
        f'[ext_resource type="Texture2D" path="res://{name}_spritesheet.png" id="1"]',
        "",
    ]

    for frame in sheet.metadata:
        tres_lines.append(f'[sub_resource type="AtlasTexture" id="{frame["name"]}"]')
        tres_lines.append('atlas = ExtResource("1")')
        tres_lines.append(
            f'region = Rect2({frame["x"]}, {frame["y"]}, '
            f'{frame["width"]}, {frame["height"]})'
        )
        tres_lines.append("")

    exports[f"{name}_frames.tres"] = "\n".join(tres_lines).encode()
    return exports


def export_unity(sheet: SpriteSheet, name: str) -> dict[str, bytes]:
    """Export as Unity-compatible PNG with .meta hints."""
    exports = {}
    exports[f"{name}_spritesheet.png"] = _image_to_bytes(sheet.image)

    # Unity .meta file with sprite slice data
    sprites = []
    for frame in sheet.metadata:
        # Unity Y-axis is inverted (bottom-left origin)
        unity_y = sheet.image.height - frame["y"] - frame["height"]
        sprites.append({
            "name": frame["name"],
            "rect": {
                "x": frame["x"],
                "y": unity_y,
                "width": frame["width"],
                "height": frame["height"],
            },
            "pivot": {"x": 0.5, "y": 0.0},
        })

    meta = {
        "fileFormatVersion": 2,
        "TextureImporter": {
            "spriteMode": 2,  # Multiple
            "spritePixelsPerUnit": sheet.frame_size,
            "filterMode": 0,  # Point (pixel art friendly)
            "textureCompression": 0,
            "sprites": sprites,
        }
    }
    exports[f"{name}_spritesheet.png.meta"] = json.dumps(meta, indent=2).encode()
    return exports


def export_css(sheet: SpriteSheet, name: str) -> dict[str, bytes]:
    """Export as CSS sprite animation classes."""
    exports = {}
    exports[f"{name}_spritesheet.png"] = _image_to_bytes(sheet.image)

    css_lines = [
        f"/* SpriteForge — {name} sprite animation */",
        "",
        f".{name} {{",
        f"  background-image: url('{name}_spritesheet.png');",
        f"  width: {sheet.frame_size}px;",
        f"  height: {sheet.frame_size}px;",
        f"  image-rendering: pixelated;",
        f"  image-rendering: -moz-crisp-edges;",
        f"  image-rendering: crisp-edges;",
        f"  display: inline-block;",
        f"}}",
        "",
    ]

    for frame in sheet.metadata:
        css_lines.append(
            f".{name}.{frame['name']} {{ "
            f"background-position: -{frame['x']}px -{frame['y']}px; "
            f"}}"
        )

    # Add keyframe animation for walk cycle
    walk_frames = [f for f in sheet.metadata if f["name"].startswith("walk")]
    if walk_frames:
        css_lines.append("")
        css_lines.append(f"@keyframes {name}-walk {{")
        for i, frame in enumerate(walk_frames):
            pct = int(i / len(walk_frames) * 100)
            css_lines.append(
                f"  {pct}% {{ background-position: -{frame['x']}px -{frame['y']}px; }}"
            )
        css_lines.append(f"  100% {{ background-position: -{walk_frames[0]['x']}px -{walk_frames[0]['y']}px; }}")
        css_lines.append("}")
        css_lines.append("")
        css_lines.append(f".{name}.animate-walk {{")
        css_lines.append(f"  animation: {name}-walk 0.6s steps(1) infinite;")
        css_lines.append("}")

    exports[f"{name}_sprite.css"] = "\n".join(css_lines).encode()
    return exports


# Format registry
EXPORT_FORMATS = {
    "generic": {"fn": export_generic, "description": "Standard PNG + JSON metadata"},
    "phaser": {"fn": export_phaser, "description": "Phaser 3 JSON Atlas"},
    "godot": {"fn": export_godot, "description": "Godot 4 SpriteFrames .tres"},
    "unity": {"fn": export_unity, "description": "Unity 2D .meta file"},
    "css": {"fn": export_css, "description": "CSS sprite animation classes"},
}


def export(
    sheet: SpriteSheet,
    format_type: str,
    character_name: str = "character",
    individual_frames: list[GeneratedPose] | None = None,
) -> dict[str, bytes]:
    """Export sprite sheet in the specified format.

    Args:
        sheet: Assembled sprite sheet.
        format_type: One of "generic", "phaser", "godot", "unity", "css".
        character_name: Name prefix for output files.
        individual_frames: Optional list of poses to include as separate PNGs.

    Returns:
        Dict mapping filename → file bytes.
    """
    if format_type not in EXPORT_FORMATS:
        available = ", ".join(EXPORT_FORMATS.keys())
        raise ValueError(f"Unknown format '{format_type}'. Available: {available}")

    exports = EXPORT_FORMATS[format_type]["fn"](sheet, character_name)

    # Optionally include individual frame PNGs
    if individual_frames:
        for pose in individual_frames:
            key = f"frames/{pose.pose_name}.png"
            exports[key] = _image_to_bytes(pose.image)

    return exports


def save_to_disk(exports: dict[str, bytes], output_dir: str) -> list[str]:
    """Save exported files to disk.

    Args:
        exports: Dict from export().
        output_dir: Directory to save files into.

    Returns:
        List of saved file paths.
    """
    saved = []
    for filename, data in exports.items():
        filepath = os.path.join(output_dir, filename)
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, "wb") as f:
            f.write(data)
        saved.append(filepath)
    return saved


def save_as_zip(exports: dict[str, bytes], zip_path: str) -> str:
    """Save exported files as a ZIP archive.

    Args:
        exports: Dict from export().
        zip_path: Path for the output ZIP file.

    Returns:
        Path to the created ZIP file.
    """
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for filename, data in exports.items():
            zf.writestr(filename, data)
    return zip_path


def _image_to_bytes(image: Image.Image) -> bytes:
    """Convert PIL Image to PNG bytes."""
    buf = BytesIO()
    image.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
