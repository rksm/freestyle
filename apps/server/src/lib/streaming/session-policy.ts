/**
 * Some providers tolerate long-lived warm sessions well; others need one
 * upstream WebSocket per recording. Soniox logs one request for the full
 * lifetime of its upstream WebSocket. Deepgram only guarantees a definitive
 * completion message when CloseStream ends the socket. Freestyle Cloud also
 * closes its upstream after each transcription. The next connection opens on
 * `start` (hotkey-down), which gives it a natural pre-warm window while the
 * user is still speaking.
 */
export function shouldKeepStreamingUpstreamAlive(providerId: string): boolean {
  return (
    providerId !== "deepgram" &&
    providerId !== "soniox" &&
    providerId !== "freestyle-cloud"
  );
}
