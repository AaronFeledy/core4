import {
  AppliedStateVersionError,
  LandofileEventInvocationDepthError,
  LandofileEventLifecycleReentryError,
  LandofileEventStepFailedError,
} from "@lando/sdk/errors";

export type EventBoundaryError = LandofileEventInvocationDepthError | LandofileEventLifecycleReentryError;
export type EventRuntimeError = EventBoundaryError | LandofileEventStepFailedError;

export const isEventBoundaryError = (error: unknown): error is EventBoundaryError =>
  error instanceof LandofileEventInvocationDepthError || error instanceof LandofileEventLifecycleReentryError;

export const isEventRuntimeError = (error: unknown): error is EventRuntimeError =>
  isEventBoundaryError(error) || error instanceof LandofileEventStepFailedError;

/** Stable reasons on located issues for refused public route-fact reads. */
export type ServiceUrlFailureReason =
  | "event-phase"
  | "unknown-service"
  | "app-not-started"
  | "applied-state-newer"
  | "applied-state-unreadable"
  | "runtime-unavailable"
  | "no-applied-route"
  | "routing-disabled"
  | "router-unsupported"
  | "authority-unavailable";

// Classify at the refusal site. Bounded/redacted diagnostics may not retain any evidence of it.
const invocationRefusals = new WeakSet<object>();

export const markInvocationRefusal = <A extends object>(error: A): A => {
  invocationRefusals.add(error);
  return error;
};

/**
 * A step refused because its public route facts or newer applied state cannot be read. `ignoreError`
 * covers a step that ran and failed, never one whose command Lando could not build.
 */
export const isInvocationRefusal = (error: unknown): boolean =>
  error instanceof AppliedStateVersionError ||
  (typeof error === "object" && error !== null && invocationRefusals.has(error));

export const preserveInvocationRefusal = <A extends object>(original: unknown, projected: A): A =>
  isInvocationRefusal(original) ? markInvocationRefusal(projected) : projected;
