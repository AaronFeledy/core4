import { Effect, Either, Exit, Schema } from "effect";

import { emitLandofileYamlEither, parseLandofile } from "../landofile/index.ts";
import type {
  ConfigTranslateInput,
  ConfigTranslateMatch,
  ConfigTranslatorShape,
  LandofileFragment,
} from "../services/index.ts";
import { ContractFailure, isNonEmptyString } from "./_shared.ts";

const stableUnknown = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableUnknown);
  if (value instanceof Map) {
    return Array.from(value.entries())
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([key, entry]) => [key, stableUnknown(entry)]);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableUnknown(entry)]),
    );
  }
  return value;
};

const stableJson = (value: unknown): string => JSON.stringify(stableUnknown(value));

// ---------------------------------------------------------------------------
// ConfigTranslator contract suite
// ---------------------------------------------------------------------------

const configTranslatorContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `ConfigTranslator contract failed: ${assertion}`, assertion, details });

const requireConfigTranslatorContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(configTranslatorContractFailure(assertion, details));

/**
 * Drives any `ConfigTranslator` through the published config-translator contract:
 * `detect()` is authoritative; `translate()` returns a schema-valid
 * `LandofileShape` fragment plus diagnostics (never an `AppPlan`, never a file
 * mutation/provider contact/plugin install); output is deterministic; and the
 * emitted fragment round-trips through the canonical Landofile serializer.
 * `translator` and `matchingInput` are required; the remaining fields
 * are optional probes asserted only when the harness supplies the hook.
 */
export interface ConfigTranslatorContractHarness {
  /** Optional label woven into failure messages. */
  readonly name?: string;
  /** The translator under test. */
  readonly translator: ConfigTranslatorShape;
  /** An input the translator detects and translates. */
  readonly matchingInput: ConfigTranslateInput;
  /**
   * Optional: an input the translator must NOT detect, proving detection is
   * authoritative (advisory globs alone never force translation).
   */
  readonly nonMatchingInput?: ConfigTranslateInput;
  /** Optional: the exact fragment the translator must emit for `matchingInput`. */
  readonly expectedFragment?: LandofileFragment;
  /**
   * Optional: an options schema and an invalid options value. When supplied the
   * suite asserts invalid options are rejected before `translate` runs.
   */
  readonly optionsSchema?: Schema.Schema<unknown, unknown>;
  /** Optional: an options value that must fail `optionsSchema` decode. */
  readonly invalidOptions?: unknown;
  /**
   * Optional: a snapshot/assert pair proving `translate` performed no external
   * mutation (no file write, provider contact, or plugin install).
   */
  readonly mutationProbe?: {
    readonly snapshot: Effect.Effect<unknown>;
    readonly assertUnchanged: (before: unknown) => Effect.Effect<boolean>;
  };
}

export const runConfigTranslatorContractSuite = (
  harness: ConfigTranslatorContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const translator = harness.translator;
    const label = harness.name ?? translator.id;

    yield* requireConfigTranslatorContract(
      isNonEmptyString(translator.id),
      `${label}: translator exposes a non-empty id`,
      translator.id,
    );
    yield* requireConfigTranslatorContract(
      isNonEmptyString(translator.summary),
      `${label}: translator exposes a summary`,
      translator.summary,
    );
    yield* requireConfigTranslatorContract(
      Array.isArray(translator.inputKinds),
      `${label}: translator declares inputKinds`,
      translator.inputKinds,
    );

    const mutationBaseline =
      harness.mutationProbe === undefined ? undefined : yield* harness.mutationProbe.snapshot;

    // --- detect() is authoritative for the matching input ---
    const detectInput = { appRoot: harness.matchingInput.appRoot, files: harness.matchingInput.files };
    const matches = yield* translator
      .detect(detectInput)
      .pipe(
        Effect.mapError((cause) =>
          configTranslatorContractFailure(`${label}: detect(matching) resolves`, cause),
        ),
      );
    yield* requireConfigTranslatorContract(
      matches.length > 0,
      `${label}: detect returns at least one match for the matching input`,
      matches,
    );
    yield* requireConfigTranslatorContract(
      matches.every((match: ConfigTranslateMatch) => isNonEmptyString(match.translator)),
      `${label}: each detect match names its translator`,
      matches,
    );

    // --- detect() is authoritative for a non-matching input ---
    if (harness.nonMatchingInput) {
      const nonMatches = yield* translator
        .detect({ appRoot: harness.nonMatchingInput.appRoot, files: harness.nonMatchingInput.files })
        .pipe(
          Effect.mapError((cause) =>
            configTranslatorContractFailure(`${label}: detect(non-matching) resolves`, cause),
          ),
        );
      yield* requireConfigTranslatorContract(
        nonMatches.length === 0,
        `${label}: detect returns no match for the non-matching input (globs alone never force translation)`,
        nonMatches,
      );
    }

    // --- translate() returns a fragment + diagnostics ---
    const result = yield* translator
      .translate(harness.matchingInput)
      .pipe(
        Effect.mapError((cause) =>
          configTranslatorContractFailure(`${label}: translate(matching) resolves`, cause),
        ),
      );
    yield* requireConfigTranslatorContract(
      typeof result.fragment === "object" && result.fragment !== null && !Array.isArray(result.fragment),
      `${label}: translate returns an object fragment (never an AppPlan/array)`,
      result.fragment,
    );
    yield* requireConfigTranslatorContract(
      !("plan" in result.fragment) && !("appId" in result.fragment),
      `${label}: fragment is a LandofileShape fragment, not an AppPlan`,
      result.fragment,
    );
    yield* requireConfigTranslatorContract(
      Array.isArray(result.diagnostics),
      `${label}: translate returns diagnostics`,
      result.diagnostics,
    );

    if (harness.expectedFragment) {
      yield* requireConfigTranslatorContract(
        stableJson(result.fragment) === stableJson(harness.expectedFragment),
        `${label}: translate emits the expected fragment`,
        { actual: result.fragment, expected: harness.expectedFragment },
      );
    }

    // --- translate() is deterministic ---
    const result2 = yield* translator
      .translate(harness.matchingInput)
      .pipe(
        Effect.mapError((cause) =>
          configTranslatorContractFailure(`${label}: repeat translate resolves`, cause),
        ),
      );
    yield* requireConfigTranslatorContract(
      stableJson(result.fragment) === stableJson(result2.fragment),
      `${label}: translate is deterministic for identical input`,
      { first: result.fragment, second: result2.fragment },
    );

    // --- the emitted fragment round-trips through the canonical serializer ---
    const emitEither = emitLandofileYamlEither(result.fragment as Record<string, unknown>);
    let emitted: string;
    if (Either.isLeft(emitEither)) {
      yield* requireConfigTranslatorContract(
        false,
        `${label}: emitted fragment is serializable by the canonical Landofile emitter`,
        emitEither.left,
      );
      emitted = "";
    } else {
      emitted = emitEither.right;
    }
    const reparsed = yield* parseLandofile({ file: "lando.yml", content: emitted, cwd: "/" }).pipe(
      Effect.mapError((cause) =>
        configTranslatorContractFailure(
          `${label}: emitted fragment parses through the canonical serializer`,
          cause,
        ),
      ),
    );
    yield* requireConfigTranslatorContract(
      stableJson(reparsed) === stableJson(result.fragment),
      `${label}: emitted fragment round-trips through the canonical Landofile serializer`,
      { reparsed, fragment: result.fragment, emitted },
    );

    // --- optional: options are validated before translate ---
    if (harness.optionsSchema && harness.invalidOptions !== undefined) {
      const decoded = Schema.decodeUnknownEither(harness.optionsSchema)(harness.invalidOptions);
      yield* requireConfigTranslatorContract(
        Either.isLeft(decoded),
        `${label}: invalid options fail schema decode before translate`,
        decoded,
      );

      const invalidOptionsRecord: Record<string, unknown> =
        typeof harness.invalidOptions === "object" &&
        harness.invalidOptions !== null &&
        !Array.isArray(harness.invalidOptions)
          ? (harness.invalidOptions as Record<string, unknown>)
          : { value: harness.invalidOptions };
      const invalidInput: ConfigTranslateInput = {
        ...harness.matchingInput,
        options: invalidOptionsRecord,
      };
      const invalidTranslateExit = yield* Effect.exit(translator.translate(invalidInput));
      yield* requireConfigTranslatorContract(
        Exit.isFailure(invalidTranslateExit),
        `${label}: translate rejects invalid options (must not succeed before schema validation)`,
        invalidTranslateExit,
      );
    }

    // --- optional: translate performed no external mutation ---
    if (harness.mutationProbe) {
      yield* translator
        .translate(harness.matchingInput)
        .pipe(
          Effect.mapError((cause) =>
            configTranslatorContractFailure(`${label}: mutation-probe translate resolves`, cause),
          ),
        );
      const unchanged = yield* harness.mutationProbe.assertUnchanged(mutationBaseline);
      yield* requireConfigTranslatorContract(
        unchanged,
        `${label}: translate did not mutate files / contact providers / install plugins`,
        mutationBaseline,
      );
    }
  });

export const makeConfigTranslatorContractSuite = runConfigTranslatorContractSuite;

// ---------------------------------------------------------------------------
// RouteFilter contract suite
// ---------------------------------------------------------------------------

/**
 * Raised by a route-filter `apply` when its options fail schema decode (or the
 * transform cannot run). SDK-test-local: route filters are a placeholder
 * production surface, so this tagged error lives with the contract suite rather
 * than `@lando/sdk/errors` until the route-filter feature story lands.
 */
export class RouteFilterError extends Schema.TaggedError<RouteFilterError>()("RouteFilterError", {
  message: Schema.String,
  filter: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

const routeFilterContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `RouteFilter contract failed: ${assertion}`, assertion, details });

const requireRouteFilterContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(routeFilterContractFailure(assertion, details));

/**
 * Drives any `RouteFilter` (the six built-ins `requestHeader` /
 * `responseHeader` / `redirect` / `rewritePath` / `stripPrefix` / `addPrefix`,
 * or a plugin-contributed filter) through the published route-filter contract:
 * the filter is provider-neutral (emits a declarative transform of the route
 * intent, never proxy-native middleware); `apply` is pure / deterministic /
 * idempotent; invalid options fail schema decode with a tagged error before the
 * plan is built; and ordering is stable across replays.
 *
 * The harness is generic over the route-plan shape (`Route`) so a fixture can
 * carry header/redirect metadata on a local `RoutePlan` extension without
 * widening the SDK `RoutePlan` schema.
 */
export interface RouteFilterContractHarness<Route, Options> {
  /** The built-in/plugin filter id (e.g. `rewritePath`). */
  readonly id: string;
  /** The filter's option schema. */
  readonly schema: Schema.Schema<Options, unknown>;
  /** A valid options value the schema accepts. */
  readonly validOptions: Options;
  /** An options value the schema must reject. */
  readonly invalidOptions: unknown;
  /** The declarative route intent fed to `apply`. */
  readonly input: Route;
  /** The pure, declarative transform under test. */
  readonly apply: (route: Route, options: Options) => Effect.Effect<Route, RouteFilterError>;
  /** The exact route intent `apply(input, validOptions)` must produce. */
  readonly expected: Route;
  /** Optional declared capabilities to match against observed behavior. */
  readonly capabilities?: ReadonlyArray<string>;
  /** Optional observed behavior tags; when supplied, must equal `capabilities`. */
  readonly behaviorTags?: ReadonlyArray<string>;
  /**
   * Optional replay sequence: applying the same options across this list of
   * routes must produce a stable, order-preserving output across replays.
   */
  readonly applySequence?: ReadonlyArray<Route>;
}

export const runRouteFilterContractSuite = <Route, Options>(
  harness: RouteFilterContractHarness<Route, Options>,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const label = harness.id;

    yield* requireRouteFilterContract(
      isNonEmptyString(harness.id),
      `${label}: filter exposes a non-empty id`,
      harness.id,
    );

    // --- invalid options fail schema decode with a tagged error ---
    const invalidDecoded = Schema.decodeUnknownEither(harness.schema)(harness.invalidOptions);
    yield* requireRouteFilterContract(
      Either.isLeft(invalidDecoded),
      `${label}: invalid options fail schema decode before the plan is built`,
      invalidDecoded,
    );

    // --- valid options decode ---
    const validDecoded = Schema.decodeUnknownEither(harness.schema)(harness.validOptions);
    yield* requireRouteFilterContract(
      Either.isRight(validDecoded),
      `${label}: valid options decode`,
      validDecoded,
    );

    // --- apply produces the expected declarative route intent ---
    const applied = yield* harness
      .apply(harness.input, harness.validOptions)
      .pipe(
        Effect.mapError((cause) =>
          routeFilterContractFailure(`${label}: apply(input, validOptions) resolves`, cause),
        ),
      );
    yield* requireRouteFilterContract(
      stableJson(applied) === stableJson(harness.expected),
      `${label}: apply produces the expected route intent`,
      { actual: applied, expected: harness.expected },
    );

    // --- output stays declarative data (a plain object, not a function/middleware) ---
    yield* requireRouteFilterContract(
      typeof applied === "object" &&
        applied !== null &&
        (Object.getPrototypeOf(applied) === Object.prototype || Object.getPrototypeOf(applied) === null),
      `${label}: apply emits declarative route data, never proxy-native middleware`,
      applied,
    );

    // --- apply is deterministic ---
    const appliedAgain = yield* harness
      .apply(harness.input, harness.validOptions)
      .pipe(Effect.mapError((cause) => routeFilterContractFailure(`${label}: repeat apply resolves`, cause)));
    yield* requireRouteFilterContract(
      stableJson(applied) === stableJson(appliedAgain),
      `${label}: apply is deterministic for identical input/options`,
      { first: applied, second: appliedAgain },
    );

    // --- apply is idempotent (applying to its own output yields the same output) ---
    const reapplied = yield* harness
      .apply(applied, harness.validOptions)
      .pipe(
        Effect.mapError((cause) =>
          routeFilterContractFailure(`${label}: idempotent reapply resolves`, cause),
        ),
      );
    yield* requireRouteFilterContract(
      stableJson(reapplied) === stableJson(applied),
      `${label}: apply is idempotent (apply twice equals apply once)`,
      { once: applied, twice: reapplied },
    );

    // --- optional: capability declaration matches observed behavior ---
    if (harness.capabilities && harness.behaviorTags) {
      const declared = [...harness.capabilities].sort();
      const observed = [...harness.behaviorTags].sort();
      yield* requireRouteFilterContract(
        JSON.stringify(declared) === JSON.stringify(observed),
        `${label}: declared capabilities match observed behavior`,
        { declared, observed },
      );
    }

    // --- optional: ordering is stable across replays ---
    if (harness.applySequence) {
      const runSequence = () =>
        Effect.forEach(harness.applySequence ?? [], (route) =>
          harness
            .apply(route, harness.validOptions)
            .pipe(
              Effect.mapError((cause) =>
                routeFilterContractFailure(`${label}: sequence apply resolves`, cause),
              ),
            ),
        );
      const firstPass = yield* runSequence();
      const secondPass = yield* runSequence();
      yield* requireRouteFilterContract(
        stableJson(firstPass) === stableJson(secondPass),
        `${label}: filter ordering/output is stable across replays`,
        { firstPass, secondPass },
      );
    }
  });

export const makeRouteFilterContractSuite = runRouteFilterContractSuite;
