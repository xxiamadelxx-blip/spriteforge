"""
Reference image processing — background removal, cropping, centering.
"""

from PIL import Image
from io import BytesIO
from rembg import remove
from dataclasses import dataclass
import numpy as np


@dataclass
class ProcessedReference:
    """Processed character reference ready for AI generation."""
    image: Image.Image
    palette: list[tuple[int, int, int]]
    style: str  # "pixel_art" | "illustration" | "realistic"
    original_size: tuple[int, int]


def remove_background(image: Image.Image) -> Image.Image:
    """Remove background using rembg (U2Net model)."""
    image_rgba = image.convert("RGBA")
    return remove(image_rgba)


def auto_crop(image: Image.Image) -> Image.Image:
    """Crop to content bounding box."""
    bbox = image.getbbox()
    if bbox:
        return image.crop(bbox)
    return image


def center_on_canvas(image: Image.Image, canvas_size: int = 512, fill_ratio: float = 0.8) -> Image.Image:
    """Center image on a transparent canvas, scaled to fill_ratio of canvas."""
    canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    max_dim = max(image.width, image.height)
    if max_dim == 0:
        return canvas
    scale = (canvas_size * fill_ratio) / max_dim
    new_w = int(image.width * scale)
    new_h = int(image.height * scale)
    resized = image.resize((new_w, new_h), Image.LANCZOS)
    offset_x = (canvas_size - new_w) // 2
    offset_y = (canvas_size - new_h) // 2
    canvas.paste(resized, (offset_x, offset_y), resized)
    return canvas


def extract_palette(image: Image.Image, n_colors: int = 5) -> list[tuple[int, int, int]]:
    """Extract dominant colors from image."""
    # Convert to RGB, ignore transparent pixels
    rgb = image.convert("RGBA")
    pixels = np.array(rgb)
    # Filter out transparent pixels
    mask = pixels[:, :, 3] > 128
    visible = pixels[mask][:, :3]
    if len(visible) == 0:
        return [(0, 0, 0)]

    # Simple quantization using PIL
    small = Image.fromarray(visible.reshape(-1, 1, 3).astype(np.uint8))
    quantized = small.quantize(colors=n_colors, method=Image.Quantize.MEDIANCUT)
    palette_data = quantized.getpalette()
    colors = []
    for i in range(n_colors):
        r, g, b = palette_data[i * 3:(i + 1) * 3]
        colors.append((r, g, b))
    return colors


def detect_art_style(image: Image.Image) -> str:
    """Detect if image is pixel art, illustration, or realistic.

    Uses edge sharpness and color count as heuristics.
    """
    rgb = image.convert("RGB")
    small = rgb.resize((64, 64), Image.NEAREST)
    arr = np.array(small)

    # Count unique colors
    reshaped = arr.reshape(-1, 3)
    unique_colors = len(np.unique(reshaped, axis=0))

    # Pixel art typically has very few unique colors
    if unique_colors < 64:
        return "pixel_art"
    elif unique_colors < 512:
        return "illustration"
    else:
        return "realistic"


def process_reference(image_bytes: bytes) -> ProcessedReference:
    """Full reference processing pipeline.

    1. Load image
    2. Remove background
    3. Auto-crop to content
    4. Center on 512x512 canvas
    5. Extract color palette
    6. Detect art style
    """
    image = Image.open(BytesIO(image_bytes)).convert("RGBA")
    original_size = (image.width, image.height)

    # Remove background
    clean = remove_background(image)

    # Crop and center
    cropped = auto_crop(clean)
    centered = center_on_canvas(cropped)

    # Analyze
    palette = extract_palette(centered)
    style = detect_art_style(centered)

    return ProcessedReference(
        image=centered,
        palette=palette,
        style=style,
        original_size=original_size,
    )
