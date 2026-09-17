export const DEVICE_PONG_STALE_MS = 70_000;

export function shouldTerminateForStalePong({ authenticated, lastPongAt, now = Date.now() }) {
  if (!authenticated) return false;
  if (!Number.isFinite(lastPongAt) || lastPongAt <= 0) return false;
  return now - lastPongAt >= DEVICE_PONG_STALE_MS;
}
