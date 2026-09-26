import { Context, Effect, Layer } from "effect";

import {
  type CreateRedactorOptions,
  type RedactionProfile,
  type Redactor,
  type TranscriptRedactionEnv,
  createRedactor,
  isUsableExactRedactionValue,
} from "@lando/sdk/secrets";
import { SecretStore } from "@lando/sdk/services";

export interface RedactionForProfileOptions {
  readonly redactionTokens?: Iterable<string> | undefined;
  readonly sourceEnv?: Record<string, string | undefined> | undefined;
  readonly proxyUrls?: Iterable<string | undefined> | undefined;
  readonly transcriptEnv?: TranscriptRedactionEnv | undefined;
}

export interface RedactionServiceShape {
  readonly registerValues: (values: ReadonlyArray<string>) => Effect.Effect<void>;
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

const SECRET_ENV_KEY_PARTS = new Set([
  "apikey",
  "apikeys",
  "authkey",
  "authkeys",
  "authtoken",
  "authtokens",
  "credential",
  "credentials",
  "key",
  "keys",
  "pass",
  "passwd",
  "passwds",
  "password",
  "passwords",
  "secret",
  "secrets",
  "token",
  "tokens",
]);

const collectSecretStoreValues = (secretStore: Context.Tag.Service<typeof SecretStore>) =>
  Effect.gen(function* () {
    const ids = yield* secretStore.list;
    const values = yield* Effect.all(
      ids.map((id) => secretStore.get(id).pipe(Effect.catchAll(() => Effect.succeed(undefined)))),
    );
    return values.filter((value): value is string => value !== undefined && value.length > 0);
  });

export const collectSecretEnvValues = (
  sourceEnv: Record<string, string | undefined> | undefined,
): string[] => {
  if (sourceEnv === undefined) return [];
  const values: string[] = [];
  for (const [key, value] of Object.entries(sourceEnv)) {
    const normalizedParts = key
      .toLowerCase()
      .split(/[._-]+/u)
      .filter(nonEmpty);
    const carriesSecret =
      key.toUpperCase() === "REDISCLI_AUTH" || normalizedParts.some((part) => SECRET_ENV_KEY_PARTS.has(part));
    if (carriesSecret && nonEmpty(value) && isUsableExactRedactionValue(value)) {
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
      if (error instanceof TypeError) continue;
      throw error;
    }
  }
  return values;
};

const collectOptionValues = (options: RedactionForProfileOptions | undefined): string[] => [
  ...collectSecretEnvValues(options?.sourceEnv),
  ...collectProxyValues(options?.proxyUrls),
  ...(options?.redactionTokens ?? []),
];

const dedupeValues = (values: Iterable<string>): string[] => {
  const deduped = new Set<string>();
  for (const value of values) {
    if (nonEmpty(value) && isUsableExactRedactionValue(value)) deduped.add(value);
  }
  return [...deduped];
};

const makeRedactorOptions = (
  secretValues: Iterable<string>,
  options: RedactionForProfileOptions | undefined,
): CreateRedactorOptions => ({
  values: dedupeValues(collectOptionValues(options)),
  authoritativeValues: [...secretValues],
  ...(options?.transcriptEnv === undefined ? {} : { env: options.transcriptEnv }),
});

const registeredValues = new Set<string>();
let registeredGeneration = 0;

const addRegisteredValue = (value: string): void => {
  if (!isUsableExactRedactionValue(value) || registeredValues.has(value)) return;
  registeredValues.add(value);
  registeredGeneration += 1;
};

export const registerRedactionValues = (values: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.sync(() => {
    for (const value of values) addRegisteredValue(value);
  });

/** Clears process-lifetime registrations. Tests call this so cases do not leak values. */
export const resetRegisteredRedactionValuesForTesting = (): void => {
  if (registeredValues.size === 0) return;
  registeredValues.clear();
  registeredGeneration += 1;
};

const makeRegisteredRedactor = (
  profile: RedactionProfile,
  secretValues: ReadonlyArray<string>,
  options: RedactionForProfileOptions | undefined,
): Redactor => {
  let generation = registeredGeneration;
  let redactor = createRedactor(
    profile,
    makeRedactorOptions([...secretValues, ...registeredValues], options),
  );
  const current = (): Redactor => {
    if (generation !== registeredGeneration) {
      redactor = createRedactor(
        profile,
        makeRedactorOptions([...secretValues, ...registeredValues], options),
      );
      generation = registeredGeneration;
    }
    return redactor;
  };
  return {
    redactString: (value) => current().redactString(value),
    redactStringBounded: (value, maxBytes) => current().redactStringBounded?.(value, maxBytes),
    redactValue: (value) => current().redactValue(value),
  };
};

/**
 * Fail-safe redactor for callers where `RedactionService` may be absent but a
 * payload must never be retained raw. Applies the same profile pattern classes
 * and option-derived exact values as the service path; only secret-store values
 * are unavailable.
 */
export const createStandaloneRedactor = (
  profile: RedactionProfile,
  options?: RedactionForProfileOptions,
): Redactor => makeRegisteredRedactor(profile, [], options);

export const makeRedactionService = (
  secretStore: Context.Tag.Service<typeof SecretStore>,
): RedactionServiceShape => ({
  registerValues: registerRedactionValues,
  forProfile: (profile, options) =>
    Effect.gen(function* () {
      const secretValues = yield* collectSecretStoreValues(secretStore);
      return makeRegisteredRedactor(profile, secretValues, options);
    }),
});

export const RedactionServiceLive = Layer.effect(
  RedactionService,
  Effect.map(SecretStore, makeRedactionService),
);
