import { ConfigTranslateError, Lando3UnsupportedRecipeError } from "@lando/sdk/errors";
import { isPlainRecord, landofileLayerRank, mergeLandofiles } from "@lando/sdk/landofile";
import type {
  ConfigTranslateDiagnostic,
  ConfigTranslateOutput,
  ConfigTranslateSourceId,
  LandofileLayer,
} from "@lando/sdk/schema";
import { LandofileAuthoringFragment, LandofileAuthoringFragmentNative } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import type { Lando3TranslatorPorts } from "./contract.ts";
import {
  dedupeDiagnostics,
  droppedConfigKey,
  generatedRecipe,
  invalidOptionValue,
  unsupportedRecipe,
} from "./diagnostics.ts";
import { type LegacyPrefixView, requiredOptionViews } from "./effective-views.ts";
import { replayDecodedDeltas } from "./layer-delta-replay.ts";
import { equal, record, sorted } from "./layer-delta-values.ts";
import { type DesiredPrefix, planLayerDeltas } from "./layer-delta.ts";
import { occurrencesAt } from "./legacy-merge.ts";
import { BUNDLED_RECIPE_OPTION_MAPS, classifyRecipe, mapConfigOptions } from "./recipe-options.ts";
import type { LoweredServicePrefix } from "./service-lowering.ts";

interface LoweredPrefix {
  readonly targetLayer: LandofileLayer;
  readonly sourceIds: ReadonlyArray<ConfigTranslateSourceId>;
  readonly fragment: Readonly<Record<string, unknown>>;
}
interface LoweredRecipes {
  readonly prefixes: ReadonlyArray<LoweredPrefix>;
  readonly diagnostics: ReadonlyArray<ConfigTranslateDiagnostic>;
  readonly decomposeCalls: number;
}
/** A layer core already validated as v4. Its fragment is the desired prefix, not a legacy source. */
export interface EstablishedLayer {
  readonly layer: LandofileLayer;
  readonly sourceIds: ReadonlyArray<ConfigTranslateSourceId>;
  readonly fragment: Readonly<Record<string, unknown>>;
}
/** Recipe identity recovered from an established layer's provenance. */
export interface EstablishedRecipe {
  readonly recipeId: string;
  readonly options: Readonly<Record<string, string | boolean>>;
  readonly fragment: Readonly<Record<string, unknown>>;
}

const recipeFailure = (
  view: LegacyPrefixView,
  details: {
    readonly recipeId: string;
    readonly reason: Lando3UnsupportedRecipeError["reason"];
    readonly message: string;
    readonly remediation: string;
    readonly keyPath: ReadonlyArray<string>;
  },
): ConfigTranslateError =>
  new ConfigTranslateError({
    message: details.message,
    remediation: details.remediation,
    translator: "lando3",
    cause: new Lando3UnsupportedRecipeError({ ...details, sourceLayer: view.layer }),
  });

const sortFragment = (fragment: object): Readonly<Record<string, unknown>> => record(sorted(fragment));

const optionMemoKey = (recipeId: string, options: Readonly<Record<string, string | boolean>>): string =>
  JSON.stringify({ recipeId, options: Object.fromEntries(Object.entries(options).sort()) });

export const lowerRecipeViews = Effect.fnUntraced(function* (
  ports: Lando3TranslatorPorts,
  folded: ReadonlyArray<LegacyPrefixView>,
  established?: EstablishedRecipe,
): Effect.fn.Return<LoweredRecipes, ConfigTranslateError, never> {
  const prefixes: LoweredPrefix[] = [];
  const diagnostics: ConfigTranslateDiagnostic[] = [];
  const memo = new Map<string, LoweredPrefix["fragment"]>();
  let decomposeCalls = 0;
  if (established !== undefined)
    memo.set(optionMemoKey(established.recipeId, established.options), established.fragment);
  const views =
    established === undefined
      ? requiredOptionViews(folded)
      : folded.filter((view) => view.recipe !== undefined || view.config !== undefined);
  for (const view of views) {
    let classification = classifyRecipe(view.recipe);
    if (classification === undefined && established !== undefined && view.config !== undefined) {
      const map = BUNDLED_RECIPE_OPTION_MAPS.get(established.recipeId);
      if (map === undefined)
        return yield* Effect.fail(
          new ConfigTranslateError({
            translator: "lando3",
            message: `The already converted ${established.recipeId} recipe has no bundled option map.`,
            remediation: `Convert the app in one pass, or replace recipe ${established.recipeId} with explicit v4 services.`,
          }),
        );
      classification = {
        _tag: "supported",
        recipeId: established.recipeId,
        legacyId: established.recipeId,
        pinned: {},
        map,
      };
    }
    if (classification === undefined) continue;
    const occurrence = occurrencesAt(view.recipe, []).at(-1) ?? occurrencesAt(view.config, []).at(-1);
    if (occurrence === undefined) continue;
    switch (classification._tag) {
      case "unsupported": {
        const diagnostic = unsupportedRecipe({ ...classification, occurrence });
        return yield* Effect.fail(
          recipeFailure(view, {
            recipeId: classification.legacyId,
            reason: classification.reason,
            keyPath: ["recipe"],
            message: diagnostic.message,
            remediation: diagnostic.remediation ?? "Use explicit v4 services.",
          }),
        );
      }
      case "supported":
        break;
      default:
        return classification satisfies never;
    }
    const { recipeId } = classification;
    const factory = ports.decomposers.get(recipeId);
    if (factory === undefined)
      return yield* Effect.fail(
        recipeFailure(view, {
          recipeId,
          reason: "unknown",
          keyPath: ["recipe"],
          message: `The bundled ${recipeId} decomposer is unavailable.`,
          remediation: `Provide the missing bundled ${recipeId} decomposer before converting.`,
        }),
      );
    const mapped = mapConfigOptions(
      classification,
      view.config,
      established?.recipeId === recipeId ? established.options : undefined,
    );
    if (mapped.blocked !== undefined)
      return yield* Effect.fail(
        new ConfigTranslateError({
          translator: "lando3",
          message: "config is a tagged file reference and was not read.",
          remediation:
            "Inline config as a mapping before converting, or run the app with Lando 3. File tags are not resolved during conversion.",
        }),
      );
    for (const invalid of mapped.invalid) {
      const diagnostic = invalidOptionValue({
        recipeId,
        legacyKey: invalid.legacyKey,
        option: invalid.option,
        occurrence: invalid.occurrences.at(-1) ?? occurrence,
        ...(invalid.spec.kind === "enum"
          ? { kind: "enum" as const, allowed: invalid.spec.values }
          : { kind: invalid.spec.kind }),
      });
      return yield* Effect.fail(
        recipeFailure(view, {
          recipeId,
          reason: "invalid-option",
          keyPath: ["config", invalid.legacyKey],
          message: diagnostic.message,
          remediation: diagnostic.remediation ?? "Choose a supported option value.",
        }),
      );
    }
    for (const entry of mapped.dropped)
      for (const authored of entry.occurrences) {
        diagnostics.push(droppedConfigKey({ recipeId, legacyKey: entry.legacyKey, occurrence: authored }));
      }
    const key = optionMemoKey(recipeId, mapped.options);
    let fragment = memo.get(key);
    if (fragment === undefined) {
      const decomposer = factory({ redactor: ports.redactor });
      if (decomposer.producer.recipeId !== recipeId)
        return yield* Effect.fail(
          recipeFailure(view, {
            recipeId,
            reason: "unknown",
            keyPath: ["recipe"],
            message: `The bundled ${recipeId} decomposer has a mismatched producer.`,
            remediation: `Provide the bundled ${recipeId} decomposer with a matching producer recipeId.`,
          }),
        );
      decomposeCalls += 1;
      const decomposed = yield* decomposer
        .decompose({ producer: decomposer.producer, options: mapped.options, secrets: {} })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ConfigTranslateError({
                translator: "lando3",
                cause,
                message: ports.redactor.redactString(cause.message),
                remediation: ports.redactor.redactString(cause.remediation),
              }),
          ),
        );
      if (!isPlainRecord(decomposed.fragment))
        return yield* Effect.fail(
          new ConfigTranslateError({
            translator: "lando3",
            message: `The bundled ${recipeId} decomposer returned a non-mapping fragment.`,
            remediation: `Repair the bundled ${recipeId} decomposer to return an authoring mapping.`,
          }),
        );
      fragment = sortFragment({ recipe: decomposed.provenance, ...decomposed.fragment });
      memo.set(key, fragment);
    }
    prefixes.push({ targetLayer: view.targetLayer, sourceIds: view.sourceIds, fragment });
    diagnostics.push(generatedRecipe({ recipeId, occurrence }));
  }
  return { prefixes, diagnostics, decomposeCalls };
});

interface RecipeLayerOutputPlan {
  readonly outputs: ReadonlyArray<ConfigTranslateOutput>;
  readonly diagnostics: ReadonlyArray<ConfigTranslateDiagnostic>;
  readonly required: ReadonlyArray<LandofileLayer>;
}

export const recipeLayerOutputs: (
  folded: ReadonlyArray<LegacyPrefixView>,
  lowered: LoweredRecipes,
  names: ReadonlyArray<ConfigTranslateOutput>,
  established?: ReadonlyArray<EstablishedLayer>,
  authored?: ReadonlyArray<LoweredServicePrefix>,
) => Effect.Effect<RecipeLayerOutputPlan, ConfigTranslateError> = Effect.fnUntraced(function* (
  folded: ReadonlyArray<LegacyPrefixView>,
  lowered: LoweredRecipes,
  names: ReadonlyArray<ConfigTranslateOutput>,
  established: ReadonlyArray<EstablishedLayer> = [],
  authored: ReadonlyArray<LoweredServicePrefix> = [],
): Effect.fn.Return<RecipeLayerOutputPlan, ConfigTranslateError> {
  let desired: LoweredPrefix["fragment"] = {};
  let authoredDesired: LoweredPrefix["fragment"] = {};
  const prefixes: DesiredPrefix[] = [];
  const layers = new Map([
    ...folded.map(({ targetLayer, sourceIds }) => [targetLayer, sourceIds] as const),
    ...established.map(({ layer, sourceIds }) => [layer, sourceIds] as const),
  ]);
  for (const { targetLayer, sourceIds } of authored) {
    layers.set(targetLayer, [...new Set([...(layers.get(targetLayer) ?? []), ...sourceIds])]);
  }
  for (const [layer, sourceIds] of [...layers].sort(
    ([a], [b]) => landofileLayerRank(a) - landofileLayerRank(b),
  )) {
    const known = established.find((item) => item.layer === layer);
    desired = known
      ? mergeLandofiles([desired, known.fragment])
      : (lowered.prefixes.find(({ targetLayer }) => targetLayer === layer)?.fragment ?? desired);
    // A layer with no authored prefix keeps the previous authored services in force,
    // but an established overlay already merged into `desired` must stay on top.
    // A layer that does author services still overrides the recipe fragment.
    const authoredHere = authored.find((prefix) => prefix.targetLayer === layer);
    if (authoredHere !== undefined) authoredDesired = authoredHere.fragment;
    prefixes.push({
      layer,
      sourceIds,
      desired: mergeLandofiles(
        authoredHere === undefined ? [authoredDesired, desired] : [desired, authoredDesired],
      ),
    });
  }
  const plan = planLayerDeltas(prefixes);
  const replayed = yield* replayDecodedDeltas(prefixes, plan.emitted);
  const outputs: ConfigTranslateOutput[] = [];
  for (const { layer, fragment } of replayed) {
    const known = established.find((item) => item.layer === layer);
    if (known !== undefined && equal(known.fragment, fragment)) continue;
    const name = names.find(({ targetLayer }) => targetLayer === layer);
    const combined = sortFragment({ ...fragment, ...(isPlainRecord(name?.fragment) ? name.fragment : {}) });
    if (Object.keys(combined).length === 0) continue;
    const wire = yield* Schema.decodeUnknownEffect(LandofileAuthoringFragmentNative)(combined, {
      onExcessProperty: "error",
    }).pipe(
      Effect.flatMap((value) =>
        Schema.encodeEffect(LandofileAuthoringFragment)(value, { onExcessProperty: "error" }),
      ),
      Effect.mapError(
        (cause) => new ConfigTranslateError({ message: `Invalid directive fragment at ${layer}.`, cause }),
      ),
    );
    outputs.push({
      targetLayer: layer,
      fragment: wire,
      sourceIds:
        Object.keys(fragment).length === 0
          ? (name?.sourceIds ?? [])
          : (folded.find(({ targetLayer }) => targetLayer === layer)?.sourceIds ?? known?.sourceIds ?? []),
    });
  }
  return {
    outputs,
    diagnostics: dedupeDiagnostics(lowered.diagnostics),
    required: [...new Set(outputs.map(({ targetLayer }) => targetLayer))],
  };
});
