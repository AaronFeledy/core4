import { Effect, Either, Schema } from "effect";

import type { RecipeDecomposeError } from "../errors/recipe.ts";
import { type RecipeDecomposeInput, RecipeDecomposeResult } from "../schema/recipe-decompose.ts";
import type { RecipeProducer } from "../schema/recipe-identity.ts";
import type { Redactor } from "../secrets/index.ts";
import type { RecipeDecomposerFactory } from "../services/recipe-decomposer.ts";
import { ContractFailure } from "./_shared.ts";

export interface RecipeDecomposerContractHarness {
  readonly name?: string;
  readonly factory: RecipeDecomposerFactory;
  readonly producer: RecipeProducer;
  readonly validInput: RecipeDecomposeInput;
  readonly typedOptionFailureInput: RecipeDecomposeInput;
  readonly missingRecipeInput: RecipeDecomposeInput;
  readonly secretProbe?: {
    readonly marker: string;
    readonly input: RecipeDecomposeInput;
  };
  readonly mutationProbe?: {
    readonly snapshot: Effect.Effect<unknown>;
    readonly assertUnchanged: (before: unknown) => Effect.Effect<boolean>;
  };
}

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
};
const deepEquals = (left: unknown, right: unknown): boolean =>
  JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));

export const runRecipeDecomposerContractSuite = (
  harness: RecipeDecomposerContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const label = harness.name ?? harness.producer.recipeId;
    const failure = (assertion: string) =>
      new ContractFailure({
        message: `RecipeDecomposer contract failed: ${label}: ${assertion}`,
        assertion: `${label}: ${assertion}`,
      });
    const requireContract = (condition: boolean, assertion: string) =>
      condition ? Effect.void : Effect.fail(failure(assertion));
    const passthrough: Redactor = { redactString: (text) => text, redactValue: (value) => value };
    let stringCalls = 0;
    let valueCalls = 0;
    const redactor: Redactor = {
      redactString: (text) => {
        stringCalls += 1;
        return passthrough.redactString(text);
      },
      redactValue: (value) => {
        valueCalls += 1;
        return passthrough.redactValue(value);
      },
    };
    const decomposer = yield* Effect.try({
      try: () => harness.factory({ redactor }),
      catch: () => failure("factory constructs a decomposer with the injected redactor"),
    });
    yield* requireContract(deepEquals(decomposer.producer, harness.producer), "declared producer matches");

    const call = (input: RecipeDecomposeInput) =>
      Effect.gen(function* () {
        const probe = harness.mutationProbe;
        const before = probe === undefined ? undefined : yield* probe.snapshot;
        const outcome = yield* Effect.exit(
          Effect.tryPromise({
            try: (signal) =>
              Effect.runPromise(Effect.either(Effect.suspend(() => decomposer.decompose(input))), { signal }),
            catch: () => failure("decompose runs with no Effect context or defects"),
          }),
        );
        if (probe !== undefined) {
          yield* requireContract(
            yield* probe.assertUnchanged(before),
            "decompose did not mutate side effects after a call",
          );
        }
        const result = yield* outcome;
        if (harness.secretProbe !== undefined) {
          const serialized = yield* Effect.try({
            try: () => JSON.stringify(Either.isRight(result) ? result.right : result.left),
            catch: () => failure("decompose result or failure is JSON serializable"),
          });
          yield* requireContract(
            !serialized.includes(harness.secretProbe.marker),
            "result or failure contains no raw secret marker",
          );
        }
        return result;
      });
    const succeed = (input: RecipeDecomposeInput) =>
      call(input).pipe(
        Effect.flatMap((result) =>
          Either.isRight(result)
            ? Effect.succeed(result.right)
            : Effect.fail(failure("valid input succeeds")),
        ),
      );
    const result = yield* succeed(harness.validInput);
    yield* requireContract(
      deepEquals(result.provenance.producer, harness.producer),
      "provenance producer matches",
    );
    yield* requireContract(
      result.provenance.id === harness.producer.recipeId &&
        result.provenance.version === harness.producer.manifestVersion,
      "provenance preserves stable recipe id and version",
    );
    yield* Schema.encodeUnknown(RecipeDecomposeResult)(result, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => failure("result encodes through RecipeDecomposeResult")),
    );
    const repeated = yield* succeed(harness.validInput);
    yield* requireContract(deepEquals(result, repeated), "identical input produces deterministic results");
    const expectFailure = (input: RecipeDecomposeInput, reason: RecipeDecomposeError["reason"]) =>
      call(input).pipe(
        Effect.flatMap((outcome) =>
          requireContract(
            Either.isLeft(outcome) &&
              outcome.left._tag === "RecipeDecomposeError" &&
              outcome.left.reason === reason,
            `invalid input fails with RecipeDecomposeError reason ${reason}`,
          ),
        ),
      );
    yield* expectFailure(harness.typedOptionFailureInput, "option-type");
    yield* expectFailure(harness.missingRecipeInput, "missing-recipe");
    if (harness.secretProbe !== undefined) {
      yield* call(harness.secretProbe.input);
      yield* call(harness.secretProbe.input);
    }
    yield* requireContract(
      stringCalls + valueCalls > 0,
      "decomposer uses the injected recording redactor port",
    );
  });

export const makeRecipeDecomposerContractSuite = runRecipeDecomposerContractSuite;
