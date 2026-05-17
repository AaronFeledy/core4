/**
 * `lando doctor` — host/provider diagnostics.
 */
import { Effect } from "effect";

import type {
  NoProviderInstalledError,
  ProviderConfigError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import {
  ProviderCapabilities,
  type ProviderCapabilities as ProviderCapabilitiesShape,
} from "@lando/sdk/schema";
import { type ProviderError, RuntimeProviderRegistry } from "@lando/sdk/services";

type DoctorError = NoProviderInstalledError | ProviderConfigError | ProviderError | ProviderUnavailableError;

export interface DoctorCheck {
  readonly name: string;
  readonly status: "pass" | "fail" | "warn";
  readonly providerId: string;
  readonly providerName: string;
  readonly providerVersion: string;
  readonly runtimeStatus: string;
  readonly capabilities: Readonly<Record<string, unknown>>;
}

export interface DoctorResult {
  readonly checks: ReadonlyArray<DoctorCheck>;
}

export const doctor = (): Effect.Effect<DoctorResult, DoctorError, RuntimeProviderRegistry> =>
  Effect.gen(function* () {
    const registry = yield* RuntimeProviderRegistry;
    const provider = yield* registry.select();
    const status = yield* provider.getStatus;

    return {
      checks: [
        {
          name: "selected-provider",
          status: "pass",
          providerId: provider.id,
          providerName: provider.displayName,
          providerVersion: provider.version,
          runtimeStatus: status.message ?? (status.running ? "running" : "stopped"),
          capabilities: Object.fromEntries(
            (Object.keys(ProviderCapabilities.fields) as Array<keyof ProviderCapabilitiesShape>).map(
              (field) => [field, provider.capabilities[field]],
            ),
          ),
        },
      ],
    };
  });

const renderCapabilityValue = (value: unknown): string => {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

export const renderDoctorResult = (result: DoctorResult): string =>
  result.checks
    .flatMap((check) => [
      `${check.name}: ${check.status}`,
      `provider: ${check.providerId}`,
      `providerName: ${check.providerName}`,
      `providerVersion: ${check.providerVersion}`,
      `runtimeStatus: ${check.runtimeStatus}`,
      ...Object.entries(check.capabilities).map(
        ([field, value]) => `${field}: ${renderCapabilityValue(value)}`,
      ),
    ])
    .join("\n");
