"""
AI pose generation — uses Stable Diffusion + IP-Adapter + ControlNet
to generate consistent character poses from a reference image.
"""

import torch
from PIL import Image
from rembg import remove as remove_bg
from dataclasses import dataclass

from scripts.reference import ProcessedReference
from scripts.skeleton import get_pose_skeleton, get_all_pose_names


@dataclass
class GeneratedPose:
    """A single generated character pose."""
    pose_name: str
    image: Image.Image
    seed: int


# Style-specific prompt suffixes
STYLE_PROMPTS = {
    "pixel_art": "pixel art, 2d game sprite, clean pixels, limited color palette, retro",
    "illustration": "2d illustration, game character, clean lines, cel shaded, digital art",
    "realistic": "detailed character render, game asset, clean edges, studio lighting",
}

# Pose-specific prompt descriptions
POSE_PROMPTS = {
    "idle": "character standing idle, neutral stance, front view, relaxed",
    "walk_1": "character mid-walk, left foot forward, slight lean, side view",
    "walk_2": "character mid-walk, right foot forward, slight lean, side view",
    "run_1": "character running fast, dynamic stride, leaning forward, side view",
    "run_2": "character running fast, opposite stride, leaning forward, side view",
    "attack_1": "character winding up attack, raising weapon overhead, action pose",
    "attack_2": "character striking downward, weapon extended, dynamic action pose",
    "jump": "character jumping high, both feet off ground, arms raised, mid-air",
    "fall": "character falling down, arms flailing upward, looking down",
    "hurt": "character recoiling in pain, leaning backward, stumbling",
    "death": "character collapsed on ground, defeated, lying flat",
    "block": "character blocking defensively, arms crossed in front, bracing",
}


class SpriteGenerator:
    """Generates character poses using SD 1.5 + IP-Adapter + ControlNet.

    Designed to run on GPUs with 6GB+ VRAM (e.g., RTX 4050).
    Uses model CPU offloading for memory efficiency.
    """

    def __init__(self, device: str = "cuda"):
        """Load all AI models.

        This takes ~2-3 minutes on first run (downloads models).
        Subsequent runs use cached models.
        """
        from diffusers import StableDiffusionControlNetPipeline, ControlNetModel
        from diffusers import DDIMScheduler

        self.device = device

        print("Loading ControlNet (OpenPose)...")
        controlnet = ControlNetModel.from_pretrained(
            "lllyasviel/sd-controlnet-openpose",
            torch_dtype=torch.float16,
        )

        print("Loading Stable Diffusion 1.5...")
        self.pipe = StableDiffusionControlNetPipeline.from_pretrained(
            "runwayml/stable-diffusion-v1-5",
            controlnet=controlnet,
            torch_dtype=torch.float16,
            safety_checker=None,
        )

        # Use DDIM scheduler for cleaner outputs
        self.pipe.scheduler = DDIMScheduler.from_config(
            self.pipe.scheduler.config
        )

        # Memory optimization for 6GB VRAM
        self.pipe.enable_model_cpu_offload()
        self.pipe.enable_attention_slicing(1)

        print("Loading IP-Adapter...")
        self.pipe.load_ip_adapter(
            "h94/IP-Adapter",
            subfolder="models",
            weight_name="ip-adapter_sd15.bin",
        )
        self.pipe.set_ip_adapter_scale(0.7)

        print("All models loaded!")

    def generate_pose(
        self,
        reference: ProcessedReference,
        pose_name: str,
        seed: int | None = None,
        ip_adapter_scale: float = 0.7,
        controlnet_scale: float = 0.8,
        steps: int = 25,
        guidance: float = 7.5,
    ) -> GeneratedPose:
        """Generate a single character pose.

        Args:
            reference: Processed character reference image.
            pose_name: Name of the pose (e.g., "idle", "attack_1").
            seed: Random seed for reproducibility. None = random.
            ip_adapter_scale: How much to follow the reference character (0-1).
                Higher = more similar to reference, lower = more creative.
            controlnet_scale: How strictly to follow the pose skeleton (0-1).
                Higher = stricter pose, lower = more natural variation.
            steps: Number of diffusion steps. More = better quality, slower.
            guidance: Classifier-free guidance scale. Higher = more prompt-adherent.

        Returns:
            GeneratedPose with the generated image and metadata.
        """
        # Get pose skeleton
        skeleton = get_pose_skeleton(pose_name)

        # Build prompt
        style_suffix = STYLE_PROMPTS.get(reference.style, STYLE_PROMPTS["illustration"])
        pose_desc = POSE_PROMPTS.get(pose_name, f"character in {pose_name} pose")

        prompt = (
            f"{pose_desc}, {style_suffix}, "
            f"transparent background, single character, centered, "
            f"consistent design, game asset, high quality"
        )

        negative_prompt = (
            "blurry, low quality, deformed, extra limbs, extra fingers, "
            "multiple characters, text, watermark, signature, "
            "busy background, cropped, out of frame, ugly, duplicate"
        )

        # Set IP-Adapter scale
        self.pipe.set_ip_adapter_scale(ip_adapter_scale)

        # Seed handling
        if seed is None:
            seed = torch.randint(0, 2**32, (1,)).item()
        generator = torch.Generator(device="cpu").manual_seed(seed)

        # Generate
        result = self.pipe(
            prompt=prompt,
            negative_prompt=negative_prompt,
            image=skeleton,
            ip_adapter_image=reference.image,
            num_inference_steps=steps,
            guidance_scale=guidance,
            controlnet_conditioning_scale=controlnet_scale,
            generator=generator,
            width=512,
            height=512,
        ).images[0]

        # Post-process
        clean = self._post_process(result, reference)

        return GeneratedPose(
            pose_name=pose_name,
            image=clean,
            seed=seed,
        )

    def generate_sprite_set(
        self,
        reference: ProcessedReference,
        poses: list[str] | None = None,
        base_seed: int | None = None,
        on_progress: callable = None,
        **kwargs,
    ) -> list[GeneratedPose]:
        """Generate multiple poses for a character.

        Args:
            reference: Processed character reference.
            poses: List of pose names. None = basic set (6 poses).
            base_seed: Base seed. Each pose uses base_seed + index.
            on_progress: Optional callback(pose_name, index, total).
            **kwargs: Passed to generate_pose().

        Returns:
            List of GeneratedPose objects.
        """
        if poses is None:
            poses = ["idle", "walk_1", "walk_2", "attack_1", "jump", "death"]

        if base_seed is None:
            base_seed = torch.randint(0, 2**32, (1,)).item()

        results = []
        for i, pose_name in enumerate(poses):
            if on_progress:
                on_progress(pose_name, i, len(poses))
            else:
                print(f"Generating {pose_name}... ({i + 1}/{len(poses)})")

            pose = self.generate_pose(
                reference=reference,
                pose_name=pose_name,
                seed=base_seed + i,
                **kwargs,
            )
            results.append(pose)

        return results

    def _post_process(self, generated: Image.Image, reference: ProcessedReference) -> Image.Image:
        """Clean up a generated image.

        1. Remove any background the AI may have generated
        2. Quantize colors to match reference palette (pixel art only)
        3. Auto-crop and re-center on canvas
        """
        # Remove background
        clean = remove_bg(generated)

        # For pixel art: enforce reference color palette
        if reference.style == "pixel_art":
            clean = self._quantize_to_palette(clean, reference.palette)

        # Auto-crop and re-center
        bbox = clean.getbbox()
        if bbox:
            cropped = clean.crop(bbox)
            canvas = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
            offset_x = (512 - cropped.width) // 2
            offset_y = (512 - cropped.height) // 2
            canvas.paste(cropped, (offset_x, offset_y), cropped)
            return canvas

        return clean

    @staticmethod
    def _quantize_to_palette(
        image: Image.Image, palette: list[tuple[int, int, int]], max_colors: int = 16
    ) -> Image.Image:
        """Quantize image colors to match a reference palette."""
        if image.mode != "RGBA":
            image = image.convert("RGBA")

        # Quantize the RGB channels
        rgb = image.convert("RGB")
        quantized = rgb.quantize(colors=max_colors, method=Image.Quantize.MEDIANCUT)
        result = quantized.convert("RGB")

        # Restore alpha channel
        r, g, b = result.split()
        _, _, _, a = image.split()
        return Image.merge("RGBA", (r, g, b, a))
