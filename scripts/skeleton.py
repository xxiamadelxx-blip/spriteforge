"""
Pose skeleton drawing — creates OpenPose-style reference skeletons
for ControlNet to interpret as body poses.
"""

from PIL import Image, ImageDraw


# Limb connections: (point_a_index, point_b_index, color)
LIMB_CONNECTIONS = [
    (0, 1, "red"),       # head → neck
    (1, 2, "green"),     # neck → right shoulder
    (2, 3, "green"),     # right shoulder → right elbow
    (3, 4, "green"),     # right elbow → right wrist
    (1, 5, "blue"),      # neck → left shoulder
    (5, 6, "blue"),      # left shoulder → left elbow
    (6, 7, "blue"),      # left elbow → left wrist
    (1, 8, "yellow"),    # neck → torso
    (8, 9, "magenta"),   # torso → right hip
    (9, 10, "magenta"),  # right hip → right knee
    (10, 11, "magenta"), # right knee → right ankle
    (8, 12, "cyan"),     # torso → left hip
    (12, 13, "cyan"),    # left hip → left knee
    (13, 14, "cyan"),    # left knee → left ankle
]

# Keypoint order:
# 0: head, 1: neck, 2: right_shoulder, 3: right_elbow, 4: right_wrist,
# 5: left_shoulder, 6: left_elbow, 7: left_wrist, 8: torso,
# 9: right_hip, 10: right_knee, 11: right_ankle,
# 12: left_hip, 13: left_knee, 14: left_ankle

# Pre-defined pose keypoints (on a 512x512 canvas)
POSE_KEYPOINTS: dict[str, list[tuple[int, int]]] = {
    "idle": [
        (256, 100), (256, 160),                          # head, neck
        (200, 170), (190, 230), (185, 280),              # right arm (relaxed)
        (312, 170), (322, 230), (327, 280),              # left arm (relaxed)
        (256, 280),                                       # torso
        (220, 290), (215, 360), (210, 430),              # right leg
        (292, 290), (297, 360), (302, 430),              # left leg
    ],
    "walk_1": [
        (256, 100), (256, 160),
        (200, 170), (180, 220), (160, 250),              # right arm swung back
        (312, 170), (330, 220), (350, 250),              # left arm swung forward
        (256, 280),
        (230, 290), (200, 360), (180, 430),              # right leg forward
        (282, 290), (310, 360), (330, 430),              # left leg back
    ],
    "walk_2": [
        (256, 100), (256, 160),
        (200, 170), (220, 220), (240, 250),              # right arm swung forward
        (312, 170), (290, 220), (270, 250),              # left arm swung back
        (256, 280),
        (282, 290), (310, 360), (330, 430),              # right leg back
        (230, 290), (200, 360), (180, 430),              # left leg forward
    ],
    "run_1": [
        (256, 90), (256, 150),
        (200, 155), (165, 130), (140, 110),              # right arm up/back
        (312, 155), (350, 180), (370, 210),              # left arm forward
        (256, 260),
        (220, 270), (180, 330), (160, 400),              # right leg far forward
        (292, 270), (330, 340), (350, 400),              # left leg far back
    ],
    "run_2": [
        (256, 90), (256, 150),
        (200, 155), (230, 180), (250, 210),              # right arm forward
        (312, 155), (345, 130), (370, 110),              # left arm up/back
        (256, 260),
        (292, 270), (330, 340), (350, 400),              # right leg far back
        (220, 270), (180, 330), (160, 400),              # left leg far forward
    ],
    "attack_1": [
        (256, 100), (256, 160),
        (200, 150), (160, 120), (130, 90),               # right arm raised high
        (312, 170), (330, 190), (340, 220),              # left arm guard
        (256, 280),
        (230, 290), (225, 360), (220, 430),              # right leg planted
        (282, 290), (287, 360), (292, 430),              # left leg planted
    ],
    "attack_2": [
        (270, 100), (270, 160),
        (210, 160), (180, 200), (150, 250),              # right arm striking down
        (330, 170), (350, 200), (360, 230),              # left arm follow-through
        (270, 280),
        (240, 290), (230, 360), (225, 430),              # right leg lunging
        (300, 290), (320, 350), (340, 410),              # left leg back
    ],
    "jump": [
        (256, 80), (256, 140),
        (200, 130), (170, 100), (150, 80),               # right arm raised
        (312, 130), (342, 100), (362, 80),               # left arm raised
        (256, 240),
        (220, 250), (200, 290), (210, 330),              # right leg tucked
        (292, 250), (312, 290), (302, 330),              # left leg tucked
    ],
    "fall": [
        (256, 120), (256, 180),
        (200, 170), (170, 140), (150, 120),              # right arm flailing up
        (312, 170), (342, 140), (362, 120),              # left arm flailing up
        (256, 280),
        (220, 290), (210, 360), (220, 430),              # right leg dangling
        (292, 290), (302, 360), (292, 430),              # left leg dangling
    ],
    "hurt": [
        (270, 110), (265, 170),
        (210, 180), (190, 220), (175, 260),              # right arm recoiling
        (320, 175), (340, 210), (350, 250),              # left arm recoiling
        (260, 290),
        (225, 300), (215, 370), (210, 435),              # right leg stumbling
        (295, 295), (310, 360), (320, 425),              # left leg stumbling
    ],
    "death": [
        (150, 400), (200, 400),
        (160, 410), (120, 420), (90, 430),               # right arm sprawled
        (240, 410), (280, 420), (310, 430),              # left arm sprawled
        (280, 400),
        (320, 395), (370, 400), (420, 410),              # right leg extended
        (320, 405), (360, 415), (400, 430),              # left leg extended
    ],
    "block": [
        (256, 100), (256, 160),
        (210, 160), (220, 130), (240, 110),              # right arm crossed up
        (302, 160), (292, 130), (272, 110),              # left arm crossed up
        (256, 280),
        (220, 290), (215, 360), (210, 430),              # right leg planted wide
        (292, 290), (297, 360), (302, 430),              # left leg planted wide
    ],
}


def draw_skeleton(keypoints: list[tuple[int, int]], size: int = 512) -> Image.Image:
    """Draw an OpenPose-style skeleton from keypoint coordinates.

    Args:
        keypoints: List of (x, y) tuples for 15 body keypoints.
        size: Canvas size in pixels.

    Returns:
        RGB image with skeleton drawn on black background.
    """
    img = Image.new("RGB", (size, size), (0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Draw limb connections
    for a, b, color in LIMB_CONNECTIONS:
        if a < len(keypoints) and b < len(keypoints):
            x1, y1 = keypoints[a]
            x2, y2 = keypoints[b]
            if (x1, y1) != (0, 0) and (x2, y2) != (0, 0):
                draw.line([(x1, y1), (x2, y2)], fill=color, width=4)

    # Draw keypoint dots
    for x, y in keypoints:
        if (x, y) != (0, 0):
            draw.ellipse([(x - 4, y - 4), (x + 4, y + 4)], fill="white")

    return img


def get_pose_skeleton(pose_name: str) -> Image.Image:
    """Get a pre-drawn skeleton for a named pose.

    Args:
        pose_name: One of the keys in POSE_KEYPOINTS.

    Returns:
        512x512 RGB image with skeleton.

    Raises:
        ValueError: If pose_name is not recognized.
    """
    if pose_name not in POSE_KEYPOINTS:
        available = ", ".join(POSE_KEYPOINTS.keys())
        raise ValueError(f"Unknown pose '{pose_name}'. Available: {available}")
    return draw_skeleton(POSE_KEYPOINTS[pose_name])


def get_all_pose_names() -> list[str]:
    """Return list of all available pose names."""
    return list(POSE_KEYPOINTS.keys())


def get_all_skeletons() -> dict[str, Image.Image]:
    """Generate skeleton images for all available poses."""
    return {name: get_pose_skeleton(name) for name in POSE_KEYPOINTS}
