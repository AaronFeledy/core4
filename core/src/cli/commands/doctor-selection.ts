import { Effect, Either } from "effect";

import type { ConfigError } from "@lando/sdk/errors";
import { ProviderId } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";

import {
  CAPABILITY_DEFAULT_PROVIDER_ID,
  type ProviderSelectionInputs,
  type ProviderSelectionResolution,
  readProviderEnvVar,
} from "@lando/engine/providers/precedence";
import type { DoctorSelectionRecord } from "./doctor-contract";
import {
  type DoctorSelfCheck,
  describeDoctorFailure,
  doctorSelfCheck,
  redactDoctorMessage,
} from "./doctor-self";

export interface DoctorSelectionOptions {
  readonly flagProviderId?: string | undefined;
  readonly landofileProviderId?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

export interface GatheredSelectionInputs {
  readonly inputs: ProviderSelectionInputs;
  readonly configFailure?: unknown;
}

export const selectionConfigFailureCheck = (
  section: string,
  cause: unknown,
  redact: (value: string) => string,
): DoctorSelfCheck => {
  const described = describeDoctorFailure(cause);
  return doctorSelfCheck({
    section,
    reason: "failure",
    message: redactDoctorMessage(described.message, redact),
    ...(described.tag === undefined ? {} : { tag: described.tag }),
    solutions: [
      {
        kind: "manual",
        description:
          "Lando configuration could not be read, so this input fell back to its default. Inspect it with `lando config view` and repair or remove the offending file.",
        command: "lando config view",
      },
    ],
  });
};

const branded = (value: string | undefined): ProviderId | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return ProviderId.make(trimmed);
};

export const buildSelectionRecord = (resolution: ProviderSelectionResolution): DoctorSelectionRecord => ({
  providerId: String(resolution.providerId),
  source: resolution.source,
  inputs: {
    ...(resolution.inputs.flag === undefined ? {} : { flag: String(resolution.inputs.flag) }),
    ...(resolution.inputs.landofile === undefined ? {} : { landofile: String(resolution.inputs.landofile) }),
    ...(resolution.inputs.env === undefined ? {} : { env: String(resolution.inputs.env) }),
    ...(resolution.inputs.config === undefined ? {} : { config: String(resolution.inputs.config) }),
    capabilityDefault: String(resolution.inputs.capabilityDefault),
  },
});

export const gatherSelectionInputs = (
  options: DoctorSelectionOptions,
): Effect.Effect<GatheredSelectionInputs, never, ConfigService> =>
  Effect.gen(function* () {
    const configService = yield* ConfigService;
    const configProvider = yield* Effect.either(configService.get("defaultProviderId"));

    const flag = branded(options.flagProviderId);
    const landofile = branded(options.landofileProviderId);
    const env = readProviderEnvVar(options.env ?? process.env);
    const config = Either.isRight(configProvider) ? (configProvider.right ?? undefined) : undefined;
    return {
      inputs: {
        ...(flag === undefined ? {} : { flag }),
        ...(landofile === undefined ? {} : { landofile }),
        ...(env === undefined ? {} : { env }),
        ...(config === undefined ? {} : { config }),
        capabilityDefault: CAPABILITY_DEFAULT_PROVIDER_ID,
      },
      ...(Either.isLeft(configProvider) ? { configFailure: configProvider.left } : {}),
    };
  });

export const resolveStateDir = (
  configService: typeof ConfigService.Service,
): Effect.Effect<string | undefined, ConfigError> =>
  Effect.gen(function* () {
    const userDataRoot = yield* configService.get("userDataRoot");
    if (typeof userDataRoot !== "string" || userDataRoot.length === 0) return undefined;
    return `${userDataRoot}/providers`;
  });
