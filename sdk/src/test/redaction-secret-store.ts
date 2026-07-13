import { Cause, Effect, Exit, Option } from "effect";

import { SecretNotFoundError } from "../errors/index.ts";
import type {
  CreateRedactorOptions,
  RedactionProfile,
  Redactor,
  TranscriptRedactionEnv,
} from "../secrets/index.ts";
import type { SecretStoreShape } from "../services/index.ts";
import { ContractFailure, isNonEmptyString } from "./_shared.ts";

// ----- Redaction contract suite -------------------------------------------

const redactionContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `Redaction contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireRedactionContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(redactionContractFailure(assertion, details));

/**
 * A canonical "soup" fixture that exercises every redaction pattern class in a
 * single string. Use this as the input for golden-output assertions in the
 * redaction contract suite.
 *
 * - `text`: one string containing every pattern class.
 * - `registeredSecrets`: literal values to register in the value layer,
 *   including a prefix-pair to prove longest-first ordering and a value that
 *   also matches a bearer-token pattern to prove value-layer-before-pattern.
 * - `value`: a structured object for `redactValue` assertions.
 */
export const SECRET_SOUP_FIXTURE = Object.freeze({
  text: [
    "DB_PASSWORD=hunter2longvalue",
    "https://user:pass@host.example.com/path",
    "Authorization: Bearer abc.def.ghijklmnop",
    "?token=deadbeefsecret&api_key=anotherapikeyvalue",
    "/home/alice/projects/app",
    "C:\\Users\\alice\\AppData\\Local\\Temp\\x",
    "\\\\fileserver\\share\\secret",
    "~/.config/lando/config.yml",
    "abc123def456",
    "123e4567-e89b-12d3-a456-426614174000",
    "sha256:aabbccddee112233445566778899aabbccddee112233445566778899aabbccdd",
    "superSecretTokenLongerSuffix",
    ":54321",
    "myapp_web_ab12cd34",
  ].join(" "),

  /**
   * Literal secret values for the value layer.
   * - "superSecretToken" / "superSecretTokenLongerSuffix": prefix-pair proving longest-first.
   * - "abc.def.ghijklmnop": also matches the bearer-token pattern, proving value-layer-before-pattern.
   */
  registeredSecrets: Object.freeze([
    "hunter2longvalue",
    "superSecretToken",
    "superSecretTokenLongerSuffix",
    "abc.def.ghijklmnop",
  ] as ReadonlyArray<string>),

  /**
   * A structured value for `redactValue` assertions: nested object with
   * secret-keyed fields, an array, an Error, a cyclic reference, and a plain
   * string field containing a soup substring.
   */
  get value(): Record<string, unknown> {
    const obj: Record<string, unknown> = {
      username: "alice",
      password: "hunter2longvalue",
      token: "abc.def.ghijklmnop",
      tags: ["prod", "hunter2longvalue"],
      nested: { api_key: "anotherapikeyvalue", host: "host.example.com" },
      err: new Error("connect failed: hunter2longvalue"),
      note: "see /home/alice/projects/app for details",
    };
    // cyclic reference
    (obj as Record<string, unknown>).self = obj;
    return obj;
  },
} as const);

/**
 * Harness for {@link runRedactionContract}.
 *
 * - `name`: optional label for error messages.
 * - `makeRedactor`: factory that builds a {@link Redactor} for the given
 *   profile and options. Must be the real `createRedactor` or a conforming
 *   implementation.
 * - `golden`: per-profile expected output of
 *   `makeRedactor(profile, { values: SECRET_SOUP_FIXTURE.registeredSecrets, env })
 *    .redactString(SECRET_SOUP_FIXTURE.text)`.
 * - `goldenValue`: optional per-profile expected output of `redactValue`.
 */
export interface RedactionContractHarness {
  readonly name?: string;
  readonly makeRedactor: (profile: RedactionProfile, options?: CreateRedactorOptions) => Redactor;
  readonly golden: Record<RedactionProfile, { readonly string: string }>;
  readonly goldenValue?: Record<RedactionProfile, unknown>;
}

/**
 * Run the redaction contract assertions against a harness. Asserts (in order):
 * - byte-identical golden output per profile.
 * - value-layer-before-pattern: a registered literal that also matches a
 *   bearer-token pattern is masked to the value sentinel with no raw remnant.
 * - longest-first: with the prefix-pair registered, redacting a string
 *   containing the longer value leaves no residue of the shorter value.
 * - structure-preserving `redactValue`: arrays stay arrays, objects keep keys,
 *   Error becomes `{name, message}`, cycles become `"[circular]"`, and
 *   secret-keyed fields are masked.
 * - idempotence: `redactString(redactString(t)) === redactString(t)` on a
 *   bearer-token-only text (which is idempotent for all three profiles).
 */
export const runRedactionContract = (
  harness: RedactionContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const label = harness.name ?? "redactor";
    const env: TranscriptRedactionEnv = {
      home: "/home/alice",
      tmp: "/tmp",
      user: "alice",
      host: "host.example.com",
    };
    const profiles: ReadonlyArray<RedactionProfile> = ["secrets", "telemetry", "transcript"];

    // --- golden output per profile ---
    for (const profile of profiles) {
      const r = harness.makeRedactor(profile, {
        values: SECRET_SOUP_FIXTURE.registeredSecrets,
        env,
      });
      const actual = r.redactString(SECRET_SOUP_FIXTURE.text);
      const expected = harness.golden[profile].string;
      yield* requireRedactionContract(
        actual === expected,
        `${label} ${profile} profile produces the expected golden output`,
        { actual, expected },
      );
    }

    // --- value-layer-before-pattern ---
    // "abc.def.ghijklmnop" is both a registered secret AND matches the bearer-token
    // pattern. The value layer must mask it first so no raw remnant survives.
    const bearerText = "Authorization: Bearer abc.def.ghijklmnop";
    const bearerR = harness.makeRedactor("secrets", {
      values: SECRET_SOUP_FIXTURE.registeredSecrets,
    });
    const bearerResult = bearerR.redactString(bearerText);
    yield* requireRedactionContract(
      !bearerResult.includes("abc.def.ghijklmnop"),
      "value-layer-before-pattern: registered bearer value leaves no raw remnant",
      { input: bearerText, output: bearerResult },
    );

    // --- longest-first ---
    // With both "superSecretToken" and "superSecretTokenLongerSuffix" registered,
    // a string containing the longer value must be fully masked (no shorter residue).
    const longerText = "superSecretTokenLongerSuffix is the full value";
    const longestR = harness.makeRedactor("secrets", {
      values: SECRET_SOUP_FIXTURE.registeredSecrets,
    });
    const longestResult = longestR.redactString(longerText);
    yield* requireRedactionContract(
      !longestResult.includes("superSecretToken"),
      "longest-first: longer registered value is masked before shorter prefix",
      { input: longerText, output: longestResult },
    );

    // --- structure-preserving redactValue ---
    const valueR = harness.makeRedactor("secrets", {
      values: SECRET_SOUP_FIXTURE.registeredSecrets,
    });
    const redacted = valueR.redactValue(SECRET_SOUP_FIXTURE.value) as Record<string, unknown>;

    yield* requireRedactionContract(
      Array.isArray(redacted.tags),
      "redactValue preserves arrays as arrays",
      redacted.tags,
    );
    yield* requireRedactionContract(
      typeof redacted.nested === "object" &&
        redacted.nested !== null &&
        "api_key" in (redacted.nested as object),
      "redactValue preserves object keys",
      redacted.nested,
    );
    yield* requireRedactionContract(
      typeof redacted.err === "object" &&
        redacted.err !== null &&
        "name" in (redacted.err as object) &&
        "message" in (redacted.err as object),
      "redactValue converts Error to {name, message}",
      redacted.err,
    );
    yield* requireRedactionContract(
      redacted.self === "[circular]",
      "redactValue returns [circular] for cyclic references",
      redacted.self,
    );
    yield* requireRedactionContract(
      redacted.password === "[redacted]",
      "redactValue masks secret-keyed fields",
      redacted.password,
    );
    yield* requireRedactionContract(
      redacted.token === "[redacted]",
      "redactValue masks token-keyed fields",
      redacted.token,
    );

    if (harness.goldenValue !== undefined) {
      for (const profile of profiles) {
        const gvR = harness.makeRedactor(profile, {
          values: SECRET_SOUP_FIXTURE.registeredSecrets,
          env,
        });
        const gvActual = gvR.redactValue(SECRET_SOUP_FIXTURE.value);
        const gvExpected = harness.goldenValue[profile];
        yield* requireRedactionContract(
          JSON.stringify(gvActual) === JSON.stringify(gvExpected),
          `${label} ${profile} profile redactValue matches goldenValue`,
          { actual: gvActual, expected: gvExpected },
        );
      }
    }

    // --- idempotence (bearer-token-only text, idempotent for all profiles) ---
    const idempotenceText = "Authorization: Bearer mytoken123 https://user:pass@host.com/path";
    for (const profile of profiles) {
      const iR = harness.makeRedactor(profile, {
        values: [],
        env: { home: "/home/alice", tmp: "/tmp", user: "alice", host: "host.com" },
      });
      const once = iR.redactString(idempotenceText);
      const twice = iR.redactString(once);
      yield* requireRedactionContract(
        once === twice,
        `${label} ${profile} profile redactString is idempotent on bearer/userinfo text`,
        { once, twice },
      );
    }
  });

// ---------------------------------------------------------------------------
// SecretStore contract suite
// ---------------------------------------------------------------------------

const secretStoreContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `SecretStore contract failed: ${assertion}`, assertion, details });

const requireSecretStoreContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(secretStoreContractFailure(assertion, details));

/**
 * Drives any `SecretStore` implementation (the built-in env store, the
 * in-memory `TestSecretStore`, or a plugin-contributed store) through the
 * published secret-store contract guarantees. `store`, `known`, and `unknown` are required; the
 * remaining fields are optional capability probes that assert the fuller spec
 * guarantee only when the harness supplies the hook, so today's env store stays
 * conformant without backend/auth/offline machinery it does not yet implement.
 */
export interface SecretStoreContractHarness {
  /** Optional label woven into failure messages. */
  readonly name?: string;
  /** The `SecretStore` implementation under test. */
  readonly store: SecretStoreShape;
  /** A secret id that resolves, plus its expected value. */
  readonly known: { readonly key: string; readonly value: string };
  /** A secret id guaranteed to be absent. */
  readonly unknown: string;
  /**
   * Optional: build a value redactor seeded from the resolved secret so the
   * suite can prove resolved values never survive in rendered output.
   * Accepts the canonical `Redactor` or any `{ redactString }`-shaped value
   * redactor.
   */
  readonly redactor?: (values: ReadonlyArray<string>) => { readonly redactString: (text: string) => string };
  /**
   * Optional: a store whose backend/auth is unavailable. The suite asserts that
   * `get` surfaces a tagged error rather than a generic throw.
   */
  readonly backendFailureStore?: SecretStoreShape;
  /**
   * Optional: a store backed only by an already-cached secret with no live
   * backend. The suite asserts the known secret still resolves offline.
   */
  readonly cachedOfflineStore?: {
    readonly store: SecretStoreShape;
    readonly key: string;
    readonly value: string;
  };
}

export const runSecretStoreContractSuite = (
  harness: SecretStoreContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const label = harness.name ?? harness.store.id;
    const store = harness.store;

    yield* requireSecretStoreContract(
      isNonEmptyString(store.id),
      `${label}: store exposes a non-empty id`,
      store.id,
    );
    yield* requireSecretStoreContract(
      Effect.isEffect(store.get(harness.known.key)),
      `${label}: get is Effect-typed`,
    );
    yield* requireSecretStoreContract(Effect.isEffect(store.list), `${label}: list is Effect-typed`);

    // --- known secret resolves deterministically ---
    const first = yield* store
      .get(harness.known.key)
      .pipe(Effect.mapError((cause) => secretStoreContractFailure(`${label}: get(known) resolves`, cause)));
    yield* requireSecretStoreContract(
      first === harness.known.value,
      `${label}: get(known) returns the expected value`,
      { actual: first, expected: harness.known.value },
    );
    const second = yield* store
      .get(harness.known.key)
      .pipe(
        Effect.mapError((cause) => secretStoreContractFailure(`${label}: repeat get(known) resolves`, cause)),
      );
    yield* requireSecretStoreContract(
      first === second,
      `${label}: get(known) is deterministic across repeats`,
      { first, second },
    );

    const hasKnown = yield* store.has(harness.known.key);
    yield* requireSecretStoreContract(hasKnown === true, `${label}: has(known) is true`, hasKnown);

    const listed = yield* store.list;
    yield* requireSecretStoreContract(
      listed.includes(harness.known.key),
      `${label}: list includes the known secret id`,
      listed,
    );
    const listedAgain = yield* store.list;
    yield* requireSecretStoreContract(
      JSON.stringify(listed) === JSON.stringify(listedAgain),
      `${label}: list is deterministic across repeats`,
      { listed, listedAgain },
    );

    // --- unknown secret fails with the tagged error ---
    const unknownExit = yield* Effect.exit(store.get(harness.unknown));
    yield* requireSecretStoreContract(
      Exit.isFailure(unknownExit),
      `${label}: get(unknown) fails`,
      unknownExit,
    );
    if (Exit.isFailure(unknownExit)) {
      const failure = Cause.failureOption(unknownExit.cause);
      yield* requireSecretStoreContract(
        Option.isSome(failure) && failure.value instanceof SecretNotFoundError,
        `${label}: get(unknown) fails with SecretNotFoundError`,
        unknownExit.cause,
      );
      if (Option.isSome(failure) && failure.value instanceof SecretNotFoundError) {
        yield* requireSecretStoreContract(
          failure.value.secret === harness.unknown,
          `${label}: SecretNotFoundError carries the requested secret id`,
          failure.value,
        );
      }
    }
    const hasUnknown = yield* store.has(harness.unknown);
    yield* requireSecretStoreContract(hasUnknown === false, `${label}: has(unknown) is false`, hasUnknown);

    // --- optional: resolved values register with the canonical redactor ---
    if (harness.redactor) {
      const redactor = harness.redactor([harness.known.value]);
      const redacted = redactor.redactString(`token=${harness.known.value} trailing`);
      yield* requireSecretStoreContract(
        !redacted.includes(harness.known.value),
        `${label}: resolved value is redacted from rendered output`,
        { redacted },
      );
    }

    // --- optional: missing-backend/auth failures surface tagged errors ---
    if (harness.backendFailureStore) {
      const failExit = yield* Effect.exit(harness.backendFailureStore.get(harness.known.key));
      yield* requireSecretStoreContract(
        Exit.isFailure(failExit),
        `${label}: backend/auth failure surfaces a tagged error`,
        failExit,
      );
      if (Exit.isFailure(failExit)) {
        const failure = Cause.failureOption(failExit.cause);
        yield* requireSecretStoreContract(
          Option.isSome(failure) && typeof (failure.value as { _tag?: unknown })._tag === "string",
          `${label}: backend/auth failure is a tagged error (carries _tag)`,
          failExit.cause,
        );
      }
    }

    // --- optional: already-cached secrets resolve offline ---
    if (harness.cachedOfflineStore) {
      const cached = yield* harness.cachedOfflineStore.store
        .get(harness.cachedOfflineStore.key)
        .pipe(
          Effect.mapError((cause) =>
            secretStoreContractFailure(`${label}: cached offline get resolves`, cause),
          ),
        );
      yield* requireSecretStoreContract(
        cached === harness.cachedOfflineStore.value,
        `${label}: already-cached secret resolves offline`,
        { actual: cached, expected: harness.cachedOfflineStore.value },
      );
    }
  });

export const makeSecretStoreContractSuite = runSecretStoreContractSuite;
