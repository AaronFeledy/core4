import { RecipeManifestValidationError } from "@lando/sdk/errors";
import { type CompiledRecipeManifest, compileRecipeSource } from "@lando/sdk/recipes";
import {
  type RecipeFile,
  type RecipePostInitAction,
  type RecipeProducer,
  type RecipeSnapshot,
  parseValidationIssuePath,
  validationIssue,
} from "@lando/sdk/schema";
import { Effect } from "effect";
import { type ObservedRecipeContent, makeRecipeContentObserver } from "./compiled-source-assets.ts";
import { composeRecipeSources } from "./manifest/merge.ts";
import type { ResolvedRecipeDeclaration, ResolvedRecipeSource } from "./resolved-source-types.ts";

export type CompiledRecipeFile = ResolvedRecipeDeclaration<RecipeFile> & ObservedRecipeContent;
export type CompiledRecipeAction = ResolvedRecipeDeclaration<RecipePostInitAction> &
  Partial<ObservedRecipeContent>;

export interface CompiledRecipe {
  readonly manifest: CompiledRecipeManifest;
  readonly snapshot: RecipeSnapshot;
  readonly producer: RecipeProducer;
  readonly parents: readonly RecipeProducer[];
  readonly historyEligible: boolean;
  readonly files: readonly CompiledRecipeFile[];
  readonly postInit: readonly CompiledRecipeAction[];
}

const freezeRecipeData = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) freezeRecipeData(entry);
    Object.freeze(value);
  }
  return value;
};

/** Observe once, compile parent-first, and retain the exact bytes preparation consumes. */
export const compileResolvedRecipe = Effect.fn("RecipeSource.compileResolved")(function* (
  resolution: ResolvedRecipeSource,
): Effect.fn.Return<CompiledRecipe, RecipeManifestValidationError> {
  const observe = makeRecipeContentObserver();
  const parents: RecipeProducer[] = [];
  const compile = Effect.fnUntraced(function* (current: ResolvedRecipeSource) {
    const files: CompiledRecipeFile[] = [];
    for (const entry of current.files) {
      const observed = yield* observe(entry.origin, entry.value);
      files.push(
        Object.freeze({
          ...freezeRecipeData(structuredClone(entry)),
          get content() {
            return observed.content;
          },
          digest: observed.digest,
        }),
      );
    }
    const postInit: CompiledRecipeAction[] = [];
    for (const entry of current.postInit) {
      const action = entry.value;
      if (action.type === "bun" && action.verb === "script") {
        const observed = yield* observe(entry.origin, { src: action.script, dest: action.script });
        postInit.push(
          Object.freeze({
            ...freezeRecipeData(structuredClone(entry)),
            get content() {
              return observed.content;
            },
            digest: observed.digest,
          }),
        );
      } else postInit.push(freezeRecipeData(structuredClone(entry)));
    }
    const child = current.sources.at(-1);
    if (child === undefined)
      return yield* Effect.fail(
        new RecipeManifestValidationError({
          source: current.source.id,
          message: "Recipe resolution has no declaring source.",
          issues: [],
        }),
      );
    const manifest = yield* Effect.fromResult(
      compileRecipeSource(current.source, {
        sourceKind: child.origin.kind === "bundled" ? "bundled" : "local",
        packageName:
          child.origin.kind === "bundled"
            ? `@lando/recipe-${current.source.id}`
            : (current.source.package ?? "local"),
        assets: files.map(({ value, digest }) => ({ dest: value.dest, digest })),
        inputs: Object.fromEntries(
          postInit.flatMap((entry, index) =>
            entry.digest === undefined ? [] : [[`postInit.${index}`, entry.digest]],
          ),
        ),
        configLayers: current.configLayers,
        parents,
      }),
    ).pipe(
      Effect.mapError(
        (error) =>
          new RecipeManifestValidationError({
            source: current.source.id,
            message: error.message,
            issues: [validationIssue(parseValidationIssuePath(error.path ?? "config") ?? [], error.message)],
            remediation: error.remediation,
          }),
      ),
    );
    return {
      manifest: freezeRecipeData(manifest),
      snapshot: manifest.snapshot,
      producer: manifest.snapshot.identity,
      parents: Object.freeze([...parents]),
      historyEligible: current.historyEligible,
      files: Object.freeze(files),
      postInit: Object.freeze(postInit),
    };
  });
  for (const [index, source] of resolution.sources.slice(0, -1).entries()) {
    const ancestor = yield* compile(composeRecipeSources(resolution.sources.slice(0, index), source));
    parents.push(ancestor.producer);
  }
  return Object.freeze(yield* compile(resolution));
});

/** Public manifest service projection; init consumers use the richer artifact directly. */
export const compileResolvedRecipeSource = (
  resolution: ResolvedRecipeSource,
): Effect.Effect<CompiledRecipeManifest, RecipeManifestValidationError> =>
  compileResolvedRecipe(resolution).pipe(Effect.map(({ manifest }) => manifest));
