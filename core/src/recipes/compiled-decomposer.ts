import { setAtPath } from "@lando/engine/config-write/dot-path";
import { eligibleBindingPath, exactSecretReferenceId } from "@lando/landofile/secret-reference";
import { compiledLandofileSource } from "@lando/landofile/serializer";
import { RecipeDecomposeError } from "@lando/sdk/errors";
import {
  type CompiledRecipeManifest,
  approvedSecretReferencesOnly,
  renderCompiledRecipeSnapshot,
  sameRecipeVersion,
  validateLandofileRecipeProvenance,
  validateOptionValues,
  validateRecipeSecretPrompts,
} from "@lando/sdk/recipes";
import {
  type AbsolutePath,
  LandofileAuthoringFragmentWire,
  type RecipeDecomposeInput,
  type RecipeDecomposeResult,
  parseValidationIssuePath,
} from "@lando/sdk/schema";
import { parseSecretReference } from "@lando/sdk/secrets";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { recipeOptionRemediation } from "./builtin/option-remediation.ts";

export type CompiledRecipeDecomposerFactory = (ports: Parameters<RecipeDecomposerFactory>[0]) => {
  readonly producer: CompiledRecipeManifest["snapshot"]["identity"];
  readonly decompose: (input: RecipeDecomposeInput) => Effect.Effect<
    {
      readonly fragment: Exclude<RecipeDecomposeResult["fragment"], string>;
      readonly provenance: RecipeDecomposeResult["provenance"];
    },
    RecipeDecomposeError
  >;
};

export const makeCompiledRecipeDecomposer = (
  manifest: CompiledRecipeManifest,
  context: { readonly source: string; readonly appRoot: AbsolutePath },
): CompiledRecipeDecomposerFactory => {
  const snapshot = manifest.snapshot;
  return (ports: Parameters<RecipeDecomposerFactory>[0]) => ({
    producer: snapshot.identity,
    decompose: Effect.fn("CompiledRecipe.decompose")(function* (input) {
      if (!sameRecipeVersion(input.producer, snapshot.identity))
        return yield* Effect.fail(
          new RecipeDecomposeError({
            recipeId: manifest.id,
            reason: "missing-recipe",
            path: "producer",
            message: ports.redactor.redactString(
              `The requested producer does not match the snapshot at ${context.source}.`,
            ),
            remediation: ports.redactor.redactString(
              `Select the exact producer declared by the snapshot at ${context.source}.`,
            ),
          }),
        );
      const fail = (path: string) =>
        new RecipeDecomposeError({
          recipeId: manifest.id,
          reason: "fragment-invalid",
          path,
          message: ports.redactor.redactString(`Cannot decompose recipe at ${context.source} (${path}).`),
          remediation: ports.redactor.redactString(
            `Correct ${path} in the snapshot at ${context.source} before retrying init.`,
          ),
        });
      const values = Object.fromEntries(Object.entries(input.options).filter(([name]) => name !== "name"));
      const options = yield* Effect.fromResult(
        validateOptionValues(snapshot.optionTypes, snapshot.defaults, values),
      ).pipe(
        Effect.mapError((error) => {
          const descriptor = error.path === undefined ? undefined : snapshot.optionTypes[error.path];
          return new RecipeDecomposeError({
            recipeId: manifest.id,
            reason: "option-type",
            ...(error.path === undefined ? {} : { path: `options.${error.path}` }),
            message: ports.redactor.redactString(error.message),
            remediation:
              descriptor === undefined
                ? Object.keys(snapshot.optionTypes).length === 0
                  ? "This recipe declares no options. Remove the undeclared option."
                  : "Supply only declared recipe options."
                : recipeOptionRemediation(descriptor),
          });
        }),
      );
      const compiled = yield* Effect.fromResult(
        renderCompiledRecipeSnapshot(snapshot, options, { appRoot: context.appRoot, env: {} }),
      ).pipe(Effect.mapError((error) => fail(error.path ?? "snapshot.template")));
      const source = yield* Effect.try({
        try: () => compiledLandofileSource(compiled),
        catch: () => fail("snapshot.template"),
      });
      const provenance = yield* Effect.fromResult(
        validateLandofileRecipeProvenance({
          id: manifest.id,
          version: manifest.version,
          producer: snapshot.identity,
          options,
          ...(input.services === undefined ? {} : { services: input.services }),
        }),
      ).pipe(Effect.mapError(() => fail("recipe")));
      if (typeof provenance === "string") return yield* Effect.fail(fail("recipe"));
      const invalidSecret = (path: string) =>
        new RecipeDecomposeError({
          recipeId: manifest.id,
          reason: "invalid-secret-reference",
          path,
          message: ports.redactor.redactString(
            `Invalid secret binding declaration or approved reference at ${path}.`,
          ),
          remediation:
            "Declare a supported secret binding field and supply its approved reference or matching init-only sink; never supply raw secret values.",
        });
      const approved = yield* Effect.fromResult(approvedSecretReferencesOnly(input));
      const declarations = yield* Effect.fromResult(validateRecipeSecretPrompts(manifest)).pipe(
        Effect.mapError(() => invalidSecret("prompts")),
      );
      let boundSource: unknown = { ...source, recipe: provenance };
      for (const { promptName, disposition } of declarations) {
        const reference = approved.secrets[promptName];
        switch (disposition.kind) {
          case "secret-store": {
            const path = parseValidationIssuePath(disposition.field);
            if (
              path === undefined ||
              !eligibleBindingPath(path) ||
              path.some(
                (segment) => segment === "__proto__" || segment === "constructor" || segment === "prototype",
              ) ||
              reference?.disposition !== "secret-store"
            )
              return yield* Effect.fail(invalidSecret(`prompts.${promptName}.disposition.field`));
            const id = exactSecretReferenceId(reference.reference);
            if (id === undefined) return yield* Effect.fail(invalidSecret(`secrets.${promptName}`));
            yield* Effect.fromResult(parseSecretReference(id)).pipe(
              Effect.mapError(() => invalidSecret(`secrets.${promptName}`)),
            );
            boundSource = setAtPath(boundSource, disposition.field, reference.reference);
            break;
          }
          case "init-only":
            switch (disposition.sink.kind) {
              case "stdin":
                if (reference?.disposition !== "postInit.stdin")
                  return yield* Effect.fail(invalidSecret(`secrets.${promptName}`));
                break;
              case "secretEnv":
                if (
                  reference?.disposition !== "postInit.secretEnv" ||
                  reference.name !== disposition.sink.name
                )
                  return yield* Effect.fail(invalidSecret(`secrets.${promptName}`));
                break;
              default:
                disposition.sink satisfies never;
            }
            break;
          default:
            disposition satisfies never;
        }
      }
      const fragment = yield* Schema.decodeUnknownEffect(LandofileAuthoringFragmentWire)(boundSource, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(() => fail("snapshot.template")));
      if (typeof fragment === "string") return yield* Effect.fail(fail("snapshot.template"));
      return { fragment, provenance };
    }),
  });
};
