export const DEVICE_PONG_STALE_MS = 70_000;
export const DEVICE_SESSION_LEASE_MS = 120_000;

export function shouldTerminateForStalePong({ authenticated, lastPongAt, now = Date.now() }) {
  if (!authenticated) return false;
  if (!Number.isFinite(lastPongAt) || lastPongAt <= 0) return false;
  return now - lastPongAt >= DEVICE_PONG_STALE_MS;
}

export function shouldRotateForSessionLease({ authenticated, connectedAt, now = Date.now() }) {
  if (!authenticated) return false;
  if (!Number.isFinite(connectedAt) || connectedAt <= 0) return false;
  return now - connectedAt >= DEVICE_SESSION_LEASE_MS;
}
