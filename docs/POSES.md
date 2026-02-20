# Pose Reference Guide

## Available Poses

### Basic Set (6 poses)
Good for most 2D games. Covers standing, movement, combat, and death.

| Pose | Description | Use For |
|------|-------------|---------|
| `idle` | Standing neutral, front view | Default state |
| `walk_1` | Walk cycle frame 1 (left foot forward) | Movement animation |
| `walk_2` | Walk cycle frame 2 (right foot forward) | Movement animation |
| `attack_1` | Wind-up / weapon raised | Combat |
| `jump` | Mid-air, arms up | Platformers |
| `death` | Collapsed on ground | Game over |

### Full Set (12 poses)
Complete animation coverage for action games.

| Pose | Description | Use For |
|------|-------------|---------|
| `idle` | Standing neutral | Default |
| `walk_1` | Walk frame 1 | Walking |
| `walk_2` | Walk frame 2 | Walking |
| `run_1` | Run frame 1 | Running |
| `run_2` | Run frame 2 | Running |
| `attack_1` | Wind-up | Combat |
| `attack_2` | Strike | Combat |
| `jump` | Mid-air | Jumping |
| `fall` | Falling down | Gravity |
| `hurt` | Taking damage | Hit reaction |
| `death` | Defeated | Game over |
| `block` | Defensive stance | Defense |

### Minimal Set (4 poses)
Bare minimum for a simple game.

| Pose | Description |
|------|-------------|
| `idle` | Standing |
| `walk_1` | Walking |
| `attack_1` | Attacking |
| `death` | Defeated |

## Animation Tips

### Walk Cycle
Use `walk_1` and `walk_2` alternating at ~200ms per frame for a natural walk.

### Run Cycle
Use `run_1` and `run_2` alternating at ~150ms per frame.

### Attack
Use `attack_1` (200ms) → `attack_2` (150ms) → `idle` for a simple attack animation.

### Death
Show `hurt` (300ms) → `death` (hold) for a dramatic death sequence.

## Custom Poses
To add custom poses, edit the `ALL_KEYPOINTS` dictionary in the notebook. Each pose is defined by 15 keypoints:

```
0: head, 1: neck,
2: right_shoulder, 3: right_elbow, 4: right_wrist,
5: left_shoulder, 6: left_elbow, 7: left_wrist,
8: torso,
9: right_hip, 10: right_knee, 11: right_ankle,
12: left_hip, 13: left_knee, 14: left_ankle
```

Coordinates are on a 512x512 canvas. (256, 256) is center.
