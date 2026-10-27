import { Context, Effect, Inspectable, Layer, Redactable } from "effect";

import {
  type CreateRedactorOptions,
  REDACTED,
  type RedactionProfile,
  type Redactor,
  type TranscriptRedactionEnv,
  createRedactor,
} from "@lando/sdk/secrets";

import { expandRedactionValues } from "./exact-values.ts";
import { collectSecretEnvValues, nonEmpty } from "./heuristic-values.ts";

export {
  collectPublicCredentialValues,
  collectSecretEnvValues,
  collectSecretStructuralValues,
} from "./heuristic-values.ts";

export interface RedactionForProfileOptions {
  readonly redactionTokens?: Iterable<string> | undefined;
  /** Exact values masked like resolved secrets; an unusable one suppresses any text that contains it. */
  readonly authoritativeTokens?: Iterable<string> | undefined;
  readonly sourceEnv?: Record<string, string | undefined> | undefined;
  readonly proxyUrls?: Iterable<string | undefined> | undefined;
  readonly transcriptEnv?: TranscriptRedactionEnv | undefined;
}

export interface RedactionServiceShape {
  readonly registerValues: (values: ReadonlyArray<string>) => Effect.Effect<void>;
  /** Read this runtime's registrations live without performing secret lookups. */
  readonly payloadValues: (options?: RedactionForProfileOptions) => Effect.Effect<() => Iterable<string>>;
  readonly forProfile: (
    profile: RedactionProfile,
    options?: RedactionForProfileOptions,
  ) => Effect.Effect<Redactor, never>;
}

export class RedactionService extends Context.Service<RedactionService, RedactionServiceShape>()(
  "@lando/redaction/RedactionService",
) {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const parent = yield* Effect.serviceOption(RedactionService);
      if (parent._tag === "Some") return parent.value;
      const owner = yield* Effect.acquireRelease(
        Effect.sync(() => makeRedactionOwner()),
        (owner) => Effect.sync(owner.dispose),
      );
      return owner.service;
    }),
  );
}

/** Exact-match secrets deliberately expose bytes only through iteration. */
export class RedactionValues extends Inspectable.Class implements Redactable.Redactable, Iterable<string> {
  readonly #values: Set<string>;

  constructor(values: Iterable<string> = []) {
    super();
    this.#values = new Set(values);
  }

  [Symbol.iterator](): Iterator<string> {
    return this.#values.values();
  }

  [Redactable.symbolRedactable](): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  add(value: string): void {
    this.#values.add(value);
  }

  has(value: string): boolean {
    return this.#values.has(value);
  }

  get size(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }
}

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

/**
 * Explicit values (registrations, authoritative tokens) are authoritative: an
 * unusable one suppresses any string that contains it. Heuristic sources drop public defaults
 * when they are collected, never here.
 */
const makeRedactorOptions = (
  secretValues: Iterable<string>,
  options: RedactionForProfileOptions | undefined,
): CreateRedactorOptions => {
  const authoritativeValues = [...secretValues, ...(options?.authoritativeTokens ?? [])];
  return {
    values: expandRedactionValues([...collectOptionValues(options), ...authoritativeValues]),
    authoritativeValues,
    ...(options?.transcriptEnv === undefined ? {} : { env: options.transcriptEnv }),
  };
};

/** Key the profile and every value so cache hits cannot inherit another caller's secrets. */
type CompiledRedactors = Map<string, Redactor>;

const COMPILED_REDACTOR_LIMIT = 32;

const compileRedactor = (
  cache: CompiledRedactors,
  profile: RedactionProfile,
  options: CreateRedactorOptions,
): Redactor => {
  // Transcript environment roots are not part of the value key.
  if (options.env !== undefined) return createRedactor(profile, options);
  const key = JSON.stringify([
    profile,
    [...(options.values ?? [])],
    [...(options.authoritativeValues ?? [])],
  ]);
  const cached = cache.get(key);
  if (cached !== undefined) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const compiled = createRedactor(profile, options);
  cache.set(key, compiled);
  if (cache.size > COMPILED_REDACTOR_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) cache.delete(oldest.value);
  }
  return compiled;
};

/** Standalone redactors hold only caller-supplied values, so they share one cache. */
const standaloneCompiled: CompiledRedactors = new Map();

const makeRegisteredRedactor = (
  profile: RedactionProfile,
  registry: { readonly values: Iterable<string>; readonly generation: () => number },
  options: RedactionForProfileOptions | undefined,
  cache: CompiledRedactors,
): Redactor & Redactable.Redactable & Inspectable.Inspectable => {
  // Compile on first use: many redactors are built for error paths that never run.
  let generation = -1;
  let redactor: Redactor | undefined;
  const current = (): Redactor => {
    if (redactor === undefined || generation !== registry.generation()) {
      generation = registry.generation();
      redactor = compileRedactor(cache, profile, makeRedactorOptions(registry.values, options));
    }
    return redactor;
  };
  return {
    [Redactable.symbolRedactable]: () => REDACTED,
    [Inspectable.NodeInspectSymbol]: () => REDACTED,
    toJSON: () => REDACTED,
    toString: () => REDACTED,
    redactString: (value) => current().redactString(value),
    redactStringBounded: (value, maxBytes) => current().redactStringBounded?.(value, maxBytes),
    redactValue: (value) => current().redactValue(value),
  };
};

/**
 * Fail-safe redactor for callers where `RedactionService` may be absent but a
 * payload must never be retained raw. Applies the same profile pattern classes
 * and explicit option-derived exact values as the service path. No runtime
 * registrations or lookup authority are inherited.
 */
export const createStandaloneRedactor = (
  profile: RedactionProfile,
  options?: RedactionForProfileOptions,
): Redactor & Redactable.Redactable & Inspectable.Inspectable =>
  makeRegisteredRedactor(profile, { values: [], generation: () => 0 }, options, standaloneCompiled);

export const createPayloadValues = (
  secretValues: Iterable<string>,
  options?: RedactionForProfileOptions,
): (() => Iterable<string>) => {
  const authoritative = [...secretValues, ...(options?.authoritativeTokens ?? [])].filter(
    (v) => v.length > 0,
  );
  const values = new RedactionValues([
    ...expandRedactionValues([...collectOptionValues(options), ...authoritative]),
    ...authoritative,
  ]);
  return () => values;
};

/** Explicit host owner; dispose only after all output and producer finalizers drain. */
export const makeRedactionOwner = () => {
  const values = new RedactionValues();
  let generation = 0;
  const registry = { values, generation: () => generation };
  const compiled: CompiledRedactors = new Map();
  const service: RedactionServiceShape = {
    registerValues: (incoming) =>
      Effect.sync(() => {
        for (const value of incoming) {
          if (value.length === 0 || values.has(value)) continue;
          values.add(value);
          generation += 1;
        }
      }),
    payloadValues: (options) =>
      Effect.sync(() => {
        let previous = -1;
        let supplier = createPayloadValues([], options);
        return () => {
          if (previous !== generation) {
            supplier = createPayloadValues(values, options);
            previous = generation;
          }
          return supplier();
        };
      }),
    forProfile: (profile, options) =>
      Effect.sync(() => makeRegisteredRedactor(profile, registry, options, compiled)),
  };
  return {
    service,
    dispose: () => {
      values.clear();
      compiled.clear();
      generation += 1;
    },
  };
};

/** Independent unscoped service for explicit hosts and fixtures. */
export const makeRedactionService = (): RedactionServiceShape => makeRedactionOwner().service;
