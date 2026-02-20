# Architecture

## AI Pipeline

```
Reference Image → Background Removal → Centering
                                           ↓
                            ┌───────────────────────────────┐
                            │  For each requested pose:     │
                            │                               │
                            │  IP-Adapter (identity)        │
                            │       +                       │
                            │  ControlNet (pose skeleton)   │
                            │       +                       │
                            │  Stable Diffusion 1.5         │
                            │       ↓                       │
                            │  Post-process (bg removal,    │
                            │  palette enforcement, center) │
                            └───────────────────────────────┘
                                           ↓
                            Sprite Sheet Assembly → Export
```

## How Character Consistency Works

**IP-Adapter** takes your uploaded character image as a "visual prompt". It encodes the character's appearance (colors, style, proportions) into the generation process. This means every pose maintains the same character identity.

**ControlNet OpenPose** takes a stick-figure skeleton as input and ensures the generated character follows that body position. Different skeletons = different poses.

Together: IP-Adapter says "look like THIS character" and ControlNet says "in THIS pose".

## VRAM Requirements

| Setup | VRAM | Notes |
|-------|------|-------|
| SD 1.5 + IP-Adapter + ControlNet | ~4-6GB | With CPU offloading |
| Google Colab T4 | 16GB | Runs comfortably |
| RTX 4050 (local) | 6GB | Works with optimizations |

## Key Parameters

- **IP-Adapter Scale (0.3-1.0)**: How much the output looks like your reference. 0.7 is a good default. Higher = more similar but less pose variation.
- **ControlNet Scale (0.3-1.0)**: How strictly the pose follows the skeleton. 0.8 is good. Too high can look stiff.
- **Diffusion Steps (15-50)**: Quality vs speed tradeoff. 25 is the sweet spot.
- **Guidance Scale (5-15)**: How closely to follow the text prompt. 7.5 is standard.

## Post-Processing

1. **Background Removal**: rembg removes any background the AI may have generated
2. **Palette Enforcement** (pixel art only): Quantizes colors to match the reference
3. **Auto-crop and center**: Ensures consistent framing across all poses
4. **Nearest-neighbor downscaling** (pixel art): Prevents blurry edges when shrinking to small frame sizes
