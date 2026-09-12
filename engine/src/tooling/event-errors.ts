import {
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
