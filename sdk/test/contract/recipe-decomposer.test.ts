import { describe, expect, test } from "bun:test";
import { RecipeDecomposeError } from "@lando/sdk/errors";
import {
  LandofileAuthoringFragmentWire,
  type RecipeDecomposeInput,
  type RecipeProducer,
} from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import * as kit from "@lando/sdk/test";
import { Effect, Either, Schema } from "effect";

const producer: RecipeProducer = {
  sourceKind: "plugin",
  packageName: "reference-recipes",
  recipeId: "web",
  manifestVersion: "1.0.0",
  contentDigest: `sha256:${"a".repeat(64)}`,
};
const fragment = Schema.decodeUnknownSync(LandofileAuthoringFragmentWire)({
  name: "myapp",
  services: { web: { type: "lando", image: "nginx" } },
});
const validInput: RecipeDecomposeInput = { producer, options: { port: 80 }, secrets: {} };
const marker = "raw-secret-contract-marker";
const reference: RecipeDecomposerFactory = ({ redactor }) => ({
  producer,
  decompose: (input) =>
    Effect.suspend(() => {
      if (input.producer.recipeId !== producer.recipeId) {
        return Effect.fail(
          new RecipeDecomposeError({
            message: redactor.redactString("Recipe is unavailable."),
            remediation: "Select an installed recipe.",
            recipeId: input.producer.recipeId,
            reason: "missing-recipe",
          }),
        );
      }
      if (typeof input.options.port !== "number") {
        return Effect.fail(
          new RecipeDecomposeError({
            message: redactor.redactString("Port must be numeric."),
            remediation: "Supply a numeric port.",
            recipeId: producer.recipeId,
            reason: "option-type",
          }),
        );
      }
      redactor.redactValue({ port: input.options.port });
      return Effect.succeed({
        fragment,
        provenance: {
          id: producer.recipeId,
          version: producer.manifestVersion,
          producer,
          options: { port: input.options.port },
        },
      });
    }),
});
const harness: kit.RecipeDecomposerContractHarness = {
  factory: reference,
  producer,
  validInput,
  typedOptionFailureInput: { ...validInput, options: { port: "wrong" } },
  missingRecipeInput: { ...validInput, producer: { ...producer, recipeId: "missing" } },
  secretProbe: { marker, input: { ...validInput, options: { ...validInput.options, probe: marker } } },
};
const run = (overrides: Partial<kit.RecipeDecomposerContractHarness>) =>
  Effect.runPromise(Effect.either(kit.runRecipeDecomposerContractSuite({ ...harness, ...overrides })));
const expectFailure = (result: Either.Either<void, kit.ContractFailure>, assertion: string) => {
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
    expect(result.left).toBeInstanceOf(kit.ContractFailure);
    expect(result.left.assertion).toContain(assertion);
  }
};

describe("RecipeDecomposer contract", () => {
  test("passes for the reference decomposer", async () => {
    // Given a pure reference; when the suite runs; then all laws hold.
    expect(Either.isRight(await run({}))).toBe(true);
  });
  test("fails when the recorded producer drifts from the declared producer", async () => {
    // Given foreign provenance; when checked; then identity drift is rejected.
    const factory: RecipeDecomposerFactory = (ports) => {
      const decomposer = reference(ports);
      return {
        ...decomposer,
        decompose: (input) =>
          decomposer.decompose(input).pipe(
            Effect.map((result) => ({
              ...result,
              provenance: { ...result.provenance, producer: { ...producer, packageName: "foreign" } },
            })),
          ),
      };
    };
    expectFailure(await run({ factory }), "provenance producer");
  });
  test("fails when a typed option failure reports the wrong reason", async () => {
    // Given a mislabeled option error; when checked; then its reason is rejected.
    const factory: RecipeDecomposerFactory = (ports) => {
      const decomposer = reference(ports);
      return {
        ...decomposer,
        decompose: (input) =>
          decomposer.decompose(input).pipe(
            Effect.mapError(
              (error) =>
                new RecipeDecomposeError({
                  message: error.message,
                  remediation: error.remediation,
                  recipeId: error.recipeId,
                  reason: "unsupported-option",
                }),
            ),
          ),
      };
    };
    expectFailure(await run({ factory }), "option-type");
  });
  test("fails when a raw secret marker leaks into the result", async () => {
    // Given a raw probe copied into output; when checked; then leakage is rejected.
    const factory: RecipeDecomposerFactory = (ports) => {
      const decomposer = reference(ports);
      return {
        ...decomposer,
        decompose: (input) =>
          decomposer.decompose(input).pipe(
            Effect.map((result) => ({
              ...result,
              provenance: { ...result.provenance, options: input.options },
            })),
          ),
      };
    };
    expectFailure(await run({ factory }), "secret marker");
  });
  test("fails when decompose mutates the side-effect probe", async () => {
    // Given a mutation on each call; when checked; then side effects are rejected.
    let mutations = 0;
    const factory: RecipeDecomposerFactory = (ports) => {
      const decomposer = reference(ports);
      return {
        ...decomposer,
        decompose: (input) =>
          Effect.suspend(() => {
            mutations += 1;
            return decomposer.decompose(input);
          }),
      };
    };
    expectFailure(
      await run({
        factory,
        mutationProbe: {
          snapshot: Effect.sync(() => mutations),
          assertUnchanged: (before) => Effect.sync(() => before === mutations),
        },
      }),
      "did not mutate",
    );
  });
  test("exports the make alias", () => {
    // Given the public surface; when inspected; then the alias preserves identity.
    expect(kit.makeRecipeDecomposerContractSuite).toBe(kit.runRecipeDecomposerContractSuite);
    expect(typeof kit.runRecipeDecomposerContractSuite).toBe("function");
  });
});
