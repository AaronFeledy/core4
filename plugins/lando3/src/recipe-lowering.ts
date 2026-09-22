import { ConfigTranslateError, Lando3UnsupportedRecipeError } from "@lando/sdk/errors";
import type {
  ConfigTranslateDiagnostic,
  ConfigTranslateOutput,
  ConfigTranslateSourceId,
  LandofileLayer,
} from "@lando/sdk/schema";
import { Effect } from "effect";
import type { Lando3TranslatorPorts, LegacyOccurrence } from "./contract.ts";
import {
  dedupeDiagnostics,
  droppedConfigKey,
  generatedRecipe,
  invalidOptionValue,
  relocationDiagnostic,
  unsupportedRecipe,
} from "./diagnostics.ts";
import { type LegacyPrefixView, requiredOptionViews } from "./effective-views.ts";
import { type DesiredPrefix, planLayerDeltas } from "./layer-delta.ts";
import { occurrencesAt } from "./legacy-merge.ts";
import { classifyRecipe, mapConfigOptions } from "./recipe-options.ts";
import { isPlainRecord } from "./v4-merge.ts";

export interface LoweredPrefix {
  readonly targetLayer: LandofileLayer;
  readonly sourceIds: ReadonlyArray<ConfigTranslateSourceId>;
  readonly fragment: Readonly<Record<string, unknown>>;
}
export interface LoweredRecipes {
  readonly prefixes: ReadonlyArray<LoweredPrefix>;
  readonly diagnostics: ReadonlyArray<ConfigTranslateDiagnostic>;
  readonly decomposeCalls: number;
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

const sortedValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (typeof value !== "object" || value === null) return value;
  return sortFragment(value);
};
const sortFragment = (fragment: object): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries(fragment)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => [key, sortedValue(value)]),
  );

export const lowerRecipeViews = (
  ports: Lando3TranslatorPorts,
  folded: ReadonlyArray<LegacyPrefixView>,
): Effect.Effect<LoweredRecipes, ConfigTranslateError, never> =>
  Effect.gen(function* () {
    const prefixes: LoweredPrefix[] = [];
    const diagnostics: ConfigTranslateDiagnostic[] = [];
    const memo = new Map<string, LoweredPrefix["fragment"]>();
    let decomposeCalls = 0;
    for (const view of requiredOptionViews(folded)) {
      const classification = classifyRecipe(view.recipe);
      if (classification === undefined) continue;
      const occurrence = occurrencesAt(view.recipe, []).at(-1);
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
      const mapped = mapConfigOptions(classification, view.config);
      for (const invalid of mapped.invalid) {
        const diagnostic = invalidOptionValue({
          ...invalid,
          recipeId,
          occurrence: invalid.occurrences.at(-1) ?? occurrence,
          allowed: invalid.spec.kind === "enum" ? invalid.spec.values : undefined,
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
      const key = JSON.stringify({ recipeId, options: mapped.options });
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

export const recipeLayerOutputs = (
  folded: ReadonlyArray<LegacyPrefixView>,
  lowered: LoweredRecipes,
  names: ReadonlyArray<ConfigTranslateOutput>,
) => {
  let desired: LoweredPrefix["fragment"] = {};
  const prefixes: DesiredPrefix[] = folded.map((view) => {
    desired =
      lowered.prefixes.find(({ targetLayer }) => targetLayer === view.targetLayer)?.fragment ?? desired;
    return { layer: view.targetLayer, sourceIds: view.sourceIds, desired };
  });
  const plan = planLayerDeltas(prefixes);
  const outputs: ConfigTranslateOutput[] = plan.emitted.flatMap(({ layer, fragment }) => {
    const name = names.find(({ targetLayer }) => targetLayer === layer);
    const combined = sortFragment({ ...fragment, ...(isPlainRecord(name?.fragment) ? name.fragment : {}) });
    if (Object.keys(combined).length === 0) return [];
    return [
      {
        targetLayer: layer,
        fragment: combined,
        sourceIds:
          Object.keys(fragment).length === 0
            ? (name?.sourceIds ?? [])
            : (folded.find(({ targetLayer }) => targetLayer === layer)?.sourceIds ?? []),
      },
    ];
  });
  const diagnostics = plan.relocations.flatMap((relocation) => {
    const view = folded.find(({ targetLayer }) => targetLayer === relocation.hoistedTo);
    const sourceId = view?.sourceIds.at(-1);
    if (view === undefined || sourceId === undefined) return [];
    const occurrence: LegacyOccurrence = occurrencesAt(view.config, []).at(-1) ??
      occurrencesAt(view.recipe, []).at(-1) ?? { sourceId, layer: view.layer, keyPath: [], span: undefined };
    return [
      relocationDiagnostic({
        ...relocation,
        occurrence,
        unitLabel: relocation.unitPath
          .map((segment) => {
            switch (segment.kind) {
              case "key":
                return segment.key;
              case "item":
                return `${segment.key}[${segment.identityKey}=${segment.identity}]`;
              default:
                return segment satisfies never;
            }
          })
          .join("."),
      }),
    ];
  });
  return {
    outputs,
    diagnostics: dedupeDiagnostics([...lowered.diagnostics, ...diagnostics]),
    required: [
      ...new Set([
        ...outputs.map(({ targetLayer }) => targetLayer),
        ...plan.relocations.flatMap(({ hoistedTo, omittedFrom }) => [hoistedTo, ...omittedFrom]),
      ]),
    ],
  };
};
