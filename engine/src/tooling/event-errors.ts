import {
  LandofileEventInvocationDepthError,
  LandofileEventLifecycleReentryError,
  LandofileEventStepFailedError,
  ToolingCompileError,
} from "@lando/sdk/errors";

export type EventBoundaryError = LandofileEventInvocationDepthError | LandofileEventLifecycleReentryError;
export type EventRuntimeError = EventBoundaryError | LandofileEventStepFailedError;

export const isEventBoundaryError = (error: unknown): error is EventBoundaryError =>
  error instanceof LandofileEventInvocationDepthError || error instanceof LandofileEventLifecycleReentryError;

export const isEventRuntimeError = (error: unknown): error is EventRuntimeError =>
  isEventBoundaryError(error) || error instanceof LandofileEventStepFailedError;

/** Stable `reason` values on the located issues of a refused `services.<name>.url` read. */
const SERVICE_URL_FAILURE_REASONS = [
  "event-phase",
  "unknown-service",
  "app-not-started",
  "applied-state-unreadable",
  "no-applied-route",
  "routing-disabled",
  "router-unsupported",
  "authority-unavailable",
] as const;
export type ServiceUrlFailureReason = (typeof SERVICE_URL_FAILURE_REASONS)[number];

const serviceUrlReasons: ReadonlySet<string> = new Set(SERVICE_URL_FAILURE_REASONS);

/**
 * A step refused because a public service URL it reads cannot be resolved. `ignoreError` covers a
 * step that ran and failed, never one whose command Lando could not build, so this escapes it.
 */
export const isServiceUrlRefusal = (error: unknown): boolean =>
  (error instanceof ToolingCompileError || error instanceof LandofileEventStepFailedError) &&
  (error.issues ?? []).some(
    (issue) => issue.rule === "landofile.tooling" && serviceUrlReasons.has(issue.reason ?? ""),
  );
