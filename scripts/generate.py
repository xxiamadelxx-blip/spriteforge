"""
CLI entry point — generate sprites from the command line.

Usage:
    python -m scripts.generate --input character.png --output sprites/
    python -m scripts.generate --input character.png --poses full --size 128 --format unity
"""

import argparse
import sys
import os

from scripts.reference import process_reference
from scripts.generator import SpriteGenerator
from scripts.assembler import assemble, ANIMATION_PRESETS
from scripts.exporter import export, save_to_disk, save_as_zip
from scripts.skeleton import get_all_pose_names


def main():
    parser = argparse.ArgumentParser(
        description="SpriteForge — Generate sprite sheets from a character image."
    )
    parser.add_argument(
        "--input", "-i",
        required=True,
        help="Path to character image (PNG or JPG).",
    )
    parser.add_argument(
        "--output", "-o",
        default="output/",
        help="Output directory for generated files. Default: output/",
    )
    parser.add_argument(
        "--name", "-n",
        default="character",
        help="Character name (used for filenames). Default: character",
    )
    parser.add_argument(
        "--poses", "-p",
        default="basic",
        help=(
            "Pose preset or comma-separated list. "
            "Presets: minimal, basic, full. "
            f"Available poses: {', '.join(get_all_pose_names())}. "
            "Default: basic"
        ),
    )
    parser.add_argument(
        "--size", "-s",
        type=int,
        default=64,
        choices=[32, 64, 96, 128],
        help="Frame size in pixels. Default: 64",
    )
    parser.add_argument(
        "--format", "-f",
        default="generic",
        choices=["generic", "phaser", "godot", "unity", "css"],
        help="Export format. Default: generic",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=None,
        help="Random seed for reproducible generation.",
    )
    parser.add_argument(
        "--zip",
        action="store_true",
        help="Save output as a ZIP file instead of loose files.",
    )
    parser.add_argument(
        "--ip-scale",
        type=float,
        default=0.7,
        help="IP-Adapter scale (0-1). Higher = more like reference. Default: 0.7",
    )
    parser.add_argument(
        "--cn-scale",
        type=float,
        default=0.8,
        help="ControlNet scale (0-1). Higher = stricter pose. Default: 0.8",
    )
    parser.add_argument(
        "--steps",
        type=int,
        default=25,
        help="Diffusion steps. More = better quality, slower. Default: 25",
    )

    args = parser.parse_args()

    # Validate input file
    if not os.path.exists(args.input):
        print(f"Error: Input file not found: {args.input}")
        sys.exit(1)

    # Resolve pose list
    if args.poses in ANIMATION_PRESETS:
        pose_list = ANIMATION_PRESETS[args.poses]
    else:
        pose_list = [p.strip() for p in args.poses.split(",")]
        valid_poses = set(get_all_pose_names())
        for p in pose_list:
            if p not in valid_poses:
                print(f"Error: Unknown pose '{p}'. Available: {', '.join(valid_poses)}")
                sys.exit(1)

    # Process reference
    print(f"\n{'=' * 50}")
    print(f"SpriteForge — Generating {len(pose_list)} poses")
    print(f"{'=' * 50}")
    print(f"Input:  {args.input}")
    print(f"Output: {args.output}")
    print(f"Poses:  {', '.join(pose_list)}")
    print(f"Size:   {args.size}px")
    print(f"Format: {args.format}")
    print(f"{'=' * 50}\n")

    print("[1/4] Processing reference image...")
    with open(args.input, "rb") as f:
        image_bytes = f.read()
    reference = process_reference(image_bytes)
    print(f"  Style detected: {reference.style}")
    print(f"  Colors: {len(reference.palette)} dominant")

    print("\n[2/4] Loading AI models...")
    generator = SpriteGenerator()

    print(f"\n[3/4] Generating {len(pose_list)} poses...")
    poses = generator.generate_sprite_set(
        reference=reference,
        poses=pose_list,
        base_seed=args.seed,
        ip_adapter_scale=args.ip_scale,
        controlnet_scale=args.cn_scale,
        steps=args.steps,
    )

    print(f"\n[4/4] Assembling sprite sheet ({args.size}px frames)...")
    sheet = assemble(poses, frame_size=args.size)
    print(f"  Sheet size: {sheet.image.width}x{sheet.image.height}")
    print(f"  Frames: {sheet.total_frames} ({sheet.columns}x{sheet.rows})")

    # Export
    exports = export(
        sheet=sheet,
        format_type=args.format,
        character_name=args.name,
        individual_frames=poses,
    )

    if args.zip:
        zip_path = os.path.join(args.output, f"{args.name}_sprites.zip")
        os.makedirs(args.output, exist_ok=True)
        save_as_zip(exports, zip_path)
        print(f"\n  Saved: {zip_path}")
    else:
        saved = save_to_disk(exports, args.output)
        print(f"\n  Saved {len(saved)} files to {args.output}/")
        for path in saved:
            print(f"    {path}")

    print(f"\nDone!")


if __name__ == "__main__":
    main()
