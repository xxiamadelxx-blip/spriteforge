# SpriteForge 🎮

AI-powered sprite sheet generator. Upload a character image, get game-ready sprite sheets with multiple poses.

**Upload character → AI generates poses → Download sprite sheet**

## How It Works

1. You upload a character image (any style — pixel art, illustration, realistic)
2. AI removes the background and processes the character
3. AI generates consistent poses (idle, walk, attack, jump, death, etc.)
4. Poses are assembled into a sprite sheet
5. You download a ZIP with the sheet + metadata for your game engine

## Quick Start (Google Colab — Free)

The fastest way to use SpriteForge is through Google Colab. No installation needed, free GPU.

### Step-by-step:

1. Open the notebook: [![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/Allen-Saji/spriteforge/blob/main/notebooks/spriteforge.ipynb)

2. **Change runtime to GPU:**
   - Click `Runtime` in the top menu
   - Click `Change runtime type`
   - Select `T4 GPU`
   - Click `Save`

3. **Run each cell** from top to bottom by clicking the ▶ play button on the left side of each cell

4. **When prompted**, upload your character image

5. **Download** the generated sprite sheet ZIP

### What you get:
```
my_character_sprites.zip
├── my_character_spritesheet.png    # Full sprite sheet
├── my_character_atlas.json         # Metadata (Phaser/generic format)
└── frames/                         # Individual pose images
    ├── idle.png
    ├── walk_1.png
    ├── walk_2.png
    ├── attack.png
    ├── jump.png
    └── death.png
```

## Supported Export Formats

| Format | Files | Use With |
|--------|-------|----------|
| Generic | PNG + JSON metadata | Any engine |
| Phaser | PNG + Atlas JSON | Phaser.js |
| Godot | PNG + .tres resource | Godot 4.x |
| Unity | PNG + .meta file | Unity 2D |
| CSS | PNG + CSS classes | Web games |

## Available Poses

| Pose | Description |
|------|-------------|
| `idle` | Standing neutral, front view |
| `walk_1` | Walk cycle frame 1 |
| `walk_2` | Walk cycle frame 2 |
| `run_1` | Run cycle frame 1 |
| `run_2` | Run cycle frame 2 |
| `attack_1` | Wind-up pose |
| `attack_2` | Strike pose |
| `jump` | Mid-air |
| `fall` | Falling down |
| `hurt` | Taking damage |
| `death` | Collapsed |
| `block` | Defensive stance |

## Configuration

In the notebook, you can customize:

```python
FRAME_SIZE = 64          # 32, 64, 96, or 128 pixels per frame
CHARACTER_NAME = "ninja" # Name for output files
EXPORT_FORMAT = "phaser" # "generic", "phaser", "godot", "unity", "css"
```

## Tech Stack

- **Stable Diffusion 1.5** — Base image generation
- **IP-Adapter** — Character consistency across poses
- **ControlNet OpenPose** — Pose control via skeleton references
- **rembg** — Background removal
- **Pillow** — Image processing and sprite sheet assembly

## Project Structure

```
spriteforge/
├── notebooks/
│   └── spriteforge.ipynb      # Main Colab notebook (start here)
├── scripts/
│   ├── reference.py           # Character image processing
│   ├── generator.py           # AI pose generation
│   ├── skeleton.py            # Pose skeleton drawing
│   ├── assembler.py           # Sprite sheet assembly
│   └── exporter.py            # Export format generators
├── assets/
│   └── examples/              # Example characters and outputs
├── docs/
│   ├── ARCHITECTURE.md        # Technical deep dive
│   └── POSES.md               # Pose reference guide
└── README.md
```

## Running Locally (Optional)

If you have an NVIDIA GPU with 6GB+ VRAM:

```bash
git clone https://github.com/Allen-Saji/spriteforge.git
cd spriteforge
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python -m scripts.generate --input character.png --output sprites/
```

**Requirements:** Python 3.12+, CUDA-capable GPU, 6GB+ VRAM

## Roadmap

- [x] Core generation pipeline
- [x] Google Colab notebook
- [x] Multiple export formats
- [ ] Web UI (Next.js frontend)
- [ ] Cloud API mode (Replicate/fal.ai)
- [ ] Custom pose upload
- [ ] Batch processing
- [ ] Animation preview

## License

MIT
