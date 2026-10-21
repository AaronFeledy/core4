import { Effect } from "effect";

import { ProviderId } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";

import {
  CAPABILITY_DEFAULT_PROVIDER_ID,
  type ProviderSelectionInputs,
  type ProviderSelectionResolution,
  readProviderEnvVar,
} from "@lando/engine/providers/precedence";
import type { DoctorSelectionRecord } from "./doctor-contract";

export interface DoctorSelectionOptions {
  readonly flagProviderId?: string | undefined;
  readonly landofileProviderId?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

export interface GatheredSelectionInputs {
  readonly inputs: ProviderSelectionInputs;
}

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

export const gatherSelectionInputs = Effect.fnUntraced(function* (
  options: DoctorSelectionOptions,
): Effect.fn.Return<GatheredSelectionInputs, never, ConfigService> {
  const configService = yield* ConfigService;
  const config = (yield* configService.get("defaultProviderId")) ?? undefined;

  const flag = branded(options.flagProviderId);
  const landofile = branded(options.landofileProviderId);
  const env = readProviderEnvVar(options.env ?? process.env);
  return {
    inputs: {
      ...(flag === undefined ? {} : { flag }),
      ...(landofile === undefined ? {} : { landofile }),
      ...(env === undefined ? {} : { env }),
      ...(config === undefined ? {} : { config }),
      capabilityDefault: CAPABILITY_DEFAULT_PROVIDER_ID,
    },
  };
});

export const resolveStateDir = Effect.fnUntraced(function* (
  configService: typeof ConfigService.Service,
): Effect.fn.Return<string | undefined> {
  const userDataRoot = yield* configService.get("userDataRoot");
  if (typeof userDataRoot !== "string" || userDataRoot.length === 0) return undefined;
  return `${userDataRoot}/providers`;
});
