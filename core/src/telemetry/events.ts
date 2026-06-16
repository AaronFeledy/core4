import { Effect } from "effect";

import type { DeprecationUse } from "@lando/sdk/schema";
import type { Telemetry } from "@lando/sdk/services";

import { TELEMETRY_EVENT_FIELD_NAMES } from "./inventory.ts";

export const UPDATE_OUTCOMES = [
  "success",
  "signature_failure",
  "launch_probe_failure",
  "permission_failure",
  "network_failure",
] as const;
export type UpdateOutcome = (typeof UPDATE_OUTCOMES)[number];

// Re-export the inventory object so callers share the same source of truth.
export const TELEMETRY_EVENT_INVENTORY = TELEMETRY_EVENT_FIELD_NAMES;

export interface UpdateOutcomeTelemetryInput {
  readonly version: string;
  readonly targetVersion: string;
  readonly channel: "stable" | "next" | "dev";
  readonly platform: string;
  readonly outcome: UpdateOutcome;
}

const tagFrom = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const tag = (value as { readonly _tag?: unknown })._tag;
  return typeof tag === "string" ? tag : undefined;
};

const causeFrom = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as { readonly cause?: unknown }).cause;
};

export const updateOutcomeFromError = (error: unknown): UpdateOutcome => {
  const tag = tagFrom(error) ?? tagFrom(causeFrom(error));
  switch (tag) {
    case "UpdateSignatureVerificationError":
      return "signature_failure";
    case "UpdateLaunchProbeError":
      return "launch_probe_failure";
    case "UpdatePermissionError":
      return "permission_failure";
    case "UpdateNetworkError":
      return "network_failure";
    default:
      return "network_failure";
  }
};

export const updateOutcomeTelemetryData = (
  input: UpdateOutcomeTelemetryInput,
): Readonly<Record<(typeof TELEMETRY_EVENT_INVENTORY)["update-outcome"][number], string>> => ({
  version: input.version,
  targetVersion: input.targetVersion,
  channel: input.channel,
  platform: input.platform,
  outcome: input.outcome,
});

export const deprecationUsedTelemetryData = (
  use: DeprecationUse,
): Readonly<Record<(typeof TELEMETRY_EVENT_INVENTORY)["deprecation-used"][number], string>> => ({
  kind: use.kind,
  id: use.id,
  since: use.notice.since,
  severity: use.notice.severity,
});

export const recordUpdateOutcomeTelemetry = (
  telemetry: typeof Telemetry.Service,
  input: UpdateOutcomeTelemetryInput,
): Effect.Effect<void, never> => {
  if (!telemetry.enabled) return Effect.void;
  return telemetry.record("update-outcome", updateOutcomeTelemetryData(input));
};
