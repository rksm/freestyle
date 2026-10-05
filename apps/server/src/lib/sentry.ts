/**
 * Telemetry is disabled in this build: nothing here leaves the machine.
 *
 * The functions stay, as no-ops, so the many `capture()` call sites in routes
 * and libraries need no changes. Errors still reach the local log file through
 * the callers that log them.
 */

export function capture(
  _event: string,
  _properties?: Record<string, unknown>,
): void {}

export function captureException(
  _error: unknown,
  _additionalProperties?: Record<string, unknown>,
): void {}

export function captureModelSelection(_selection: {
  provider: string;
  modelId: string;
  type: string;
  action: "configured" | "selected";
}): void {}

export function identifyCloudUser(_user: { id: string }): void {}

export function resetCloudIdentity(): void {}

export function setPersonProperties(
  _properties: Record<string, unknown>,
): void {}

export function registerSuperProperties(
  _properties: Record<string, string | number | boolean>,
): void {}

/** Called when the user changes the telemetry setting. Nothing to update. */
export function invalidateTelemetrySetting(): void {}

export async function shutdownSentry(): Promise<void> {}
