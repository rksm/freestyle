/**
 * Some providers tolerate long-lived warm sessions well; others surface
 * those sessions as a single request spanning app idle time. Soniox logs
 * one request for the full lifetime of its upstream WebSocket, so we keep
 * those sessions ephemeral and tie them to a single recording. Freestyle
 * Cloud sessions are also ephemeral: the upstream closes after each
 * transcription and reconnects on the next `start` (hotkey-down), which
 * gives a natural pre-warm window while the user is still speaking.
 * AssemblyAI bills a session by wall-clock time, idle included, and ends each
 * recording with Terminate, so its sessions are ephemeral too.
 */
const EPHEMERAL_PROVIDERS = new Set([
  "soniox",
  "freestyle-cloud",
  "assemblyai",
]);

export function shouldKeepStreamingUpstreamAlive(providerId: string): boolean {
  return !EPHEMERAL_PROVIDERS.has(providerId);
}
