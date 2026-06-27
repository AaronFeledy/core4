import { Context, Effect, Layer } from "effect";

import {
  type CreateRedactorOptions,
  type RedactionProfile,
  type Redactor,
  type TranscriptRedactionEnv,
  createRedactor,
} from "@lando/sdk/secrets";
import { SecretStore } from "@lando/sdk/services";

export interface RedactionForProfileOptions {
  readonly redactionTokens?: Iterable<string> | undefined;
  readonly sourceEnv?: Record<string, string | undefined> | undefined;
  readonly proxyUrls?: Iterable<string | undefined> | undefined;
  readonly transcriptEnv?: TranscriptRedactionEnv | undefined;
}

export interface RedactionServiceShape {
  readonly forProfile: (
    profile: RedactionProfile,
    options?: RedactionForProfileOptions,
  ) => Effect.Effect<Redactor, never>;
}

export class RedactionService extends Context.Tag("@lando/core/RedactionService")<
  RedactionService,
  RedactionServiceShape
>() {}

const nonEmpty = (value: string | undefined): value is string =>
  value !== undefined && value.trim().length > 0;

const collectSecretStoreValues = (secretStore: Context.Tag.Service<typeof SecretStore>) =>
  Effect.gen(function* () {
    const ids = yield* secretStore.list;
    const values = yield* Effect.all(
      ids.map((id) => secretStore.get(id).pipe(Effect.catchAll(() => Effect.succeed(undefined)))),
    );
    return values.filter(nonEmpty);
  });

const collectEnvValues = (sourceEnv: Record<string, string | undefined> | undefined): string[] => {
  if (sourceEnv === undefined) return [];
  const values: string[] = [];
  for (const [key, value] of Object.entries(sourceEnv)) {
    if ((key === "BUN_AUTH_TOKEN" || key.toLowerCase().endsWith("_authtoken")) && nonEmpty(value)) {
      values.push(value);
    }
  }
  return values;
};

const collectProxyValues = (proxyUrls: Iterable<string | undefined> | undefined): string[] => {
  if (proxyUrls === undefined) return [];
  const values: string[] = [];
  for (const proxyUrl of proxyUrls) {
    if (proxyUrl === undefined) continue;
    try {
      const parsed = new URL(proxyUrl);
      if (nonEmpty(parsed.password)) values.push(parsed.password);
      if (nonEmpty(parsed.username)) values.push(parsed.username);
    } catch (error) {
      void error;
    }
  }
  return values;
};

const collectOptionValues = (options: RedactionForProfileOptions | undefined): string[] => [
  ...collectEnvValues(options?.sourceEnv),
  ...collectProxyValues(options?.proxyUrls),
  ...(options?.redactionTokens ?? []),
];

const dedupeValues = (values: Iterable<string>): string[] => {
  const deduped = new Set<string>();
  for (const value of values) {
    if (nonEmpty(value)) deduped.add(value);
  }
  return [...deduped];
};

const makeRedactorOptions = (
  secretValues: Iterable<string>,
  options: RedactionForProfileOptions | undefined,
): CreateRedactorOptions => ({
  values: dedupeValues([...secretValues, ...collectOptionValues(options)]),
  ...(options?.transcriptEnv === undefined ? {} : { env: options.transcriptEnv }),
});

/**
 * Fail-safe redactor for callers where `RedactionService` may be absent but a
 * payload must never be retained raw. Applies the same profile pattern classes
 * and option-derived exact values as the service path; only secret-store values
 * are unavailable.
 */
export const createStandaloneRedactor = (
  profile: RedactionProfile,
  options?: RedactionForProfileOptions,
): Redactor => createRedactor(profile, makeRedactorOptions([], options));

export const makeRedactionService = (
  secretStore: Context.Tag.Service<typeof SecretStore>,
): RedactionServiceShape => ({
  forProfile: (profile, options) =>
    Effect.gen(function* () {
      const secretValues = yield* collectSecretStoreValues(secretStore);
      return createRedactor(profile, makeRedactorOptions(secretValues, options));
    }),
});

export const RedactionServiceLive = Layer.effect(
  RedactionService,
  Effect.map(SecretStore, makeRedactionService),
);
