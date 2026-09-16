import { Effect, Either, Schema } from "effect";

import { ConfigTranslateError } from "../errors/config.ts";
import { validateConfigTranslateInput, validateConfigTranslateResult } from "../landofile/index.ts";
import { ConfigTranslateResult } from "../schema/config-translate.ts";
import type {
  ConfigTranslateDetectInput,
  ConfigTranslateInput,
  ConfigTranslatorShape,
} from "../services/index.ts";
import { type ConfigTranslatorEncodeSample, checkAuthoringLaws } from "./config-translator-authoring.ts";
export type { ConfigTranslatorEncodeSample } from "./config-translator-authoring.ts";
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

export interface ConfigTranslatorContractHarness {
  readonly name?: string;
  readonly translator: ConfigTranslatorShape;
  readonly translateInput: ConfigTranslateInput;
  readonly expectedResult?: ConfigTranslateResult;
  readonly detectInput?: ConfigTranslateDetectInput;
  readonly nonMatchingDetectInput?: ConfigTranslateDetectInput;
  readonly encodeSamples?: ReadonlyArray<ConfigTranslatorEncodeSample>;
  readonly decodeAuthoring?: (text: string) => Effect.Effect<unknown, unknown>;
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

    const resolve = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.mapError((cause) => configTranslatorContractFailure(`${label}: operation resolves`, cause)),
      );
    if (harness.detectInput) {
      const matches = yield* resolve(translator.detect(harness.detectInput));
      const declared = new Set(harness.detectInput.documents.map(({ sourceId }) => sourceId));
      yield* requireConfigTranslatorContract(
        matches.length > 0 &&
          matches.every(
            (match) => match.translator === translator.id && match.sourceIds.every((id) => declared.has(id)),
          ),
        `${label}: detection names this translator and declared sources`,
        matches,
      );
      const repeated = yield* resolve(translator.detect(harness.detectInput));
      yield* requireConfigTranslatorContract(
        stableJson(matches) === stableJson(repeated),
        `${label}: detection is deterministic`,
        { matches, repeated },
      );
    }
    if (harness.nonMatchingDetectInput) {
      const matches = yield* resolve(translator.detect(harness.nonMatchingDetectInput));
      yield* requireConfigTranslatorContract(
        matches.length === 0,
        `${label}: non-matching detection is empty`,
        matches,
      );
    }
    yield* resolve(validateConfigTranslateInput(harness.translateInput));
    const result = yield* resolve(translator.translate(harness.translateInput));
    yield* requireConfigTranslatorContract(
      !("plan" in result) && !("appId" in result),
      `${label}: result is not an AppPlan`,
      result,
    );
    yield* resolve(Schema.encodeUnknownEither(ConfigTranslateResult)(result, { onExcessProperty: "error" }));
    yield* resolve(
      validateConfigTranslateResult(harness.translateInput, result).pipe(
        Either.mapLeft((error) => new ConfigTranslateError({ ...error, translator: translator.id })),
      ),
    );
    const repeated = yield* resolve(translator.translate(harness.translateInput));
    yield* requireConfigTranslatorContract(
      stableJson(result) === stableJson(repeated),
      `${label}: translation and diagnostics are deterministic`,
      { result, repeated },
    );
    if (harness.expectedResult !== undefined) {
      yield* requireConfigTranslatorContract(
        stableJson(result) === stableJson(harness.expectedResult),
        `${label}: translation equals expected result`,
        { result, expected: harness.expectedResult },
      );
    }
    yield* resolve(checkAuthoringLaws(harness, result, stableJson));

    if (harness.mutationProbe) {
      yield* resolve(translator.translate(harness.translateInput));
      yield* requireConfigTranslatorContract(
        yield* harness.mutationProbe.assertUnchanged(mutationBaseline),
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
 * transform cannot run). Route filters have no production service contract,
 * so this tagged error lives with the contract suite rather than
 * `@lando/sdk/errors`.
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
  readonly schema: Schema.Schema.AnyNoContext;
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
