/**
 * The `lando3` config translator.
 *
 * Decode-only: it reads one core-ordered Lando 3 document set and lowers it to
 * Lando 4 authoring fragments. There is no `encode` arm, so nothing here can
 * write a Lando 3 file.
 *
 * The frontend owns foreign parsing and foreign merge; core owns discovery,
 * ordering, validation, and mutation. Nothing in this module opens a file,
 * follows a reference, resolves a tag, plans, or contacts a provider.
 *
 * Every key is diagnosed; nothing is silently omitted. Global-only keys have
 * explicit dispositions, and unknown keys are dropped by the model. Diagnostic
 * kind determines whether conversion is blocked.
 */
import { Effect } from "effect";

import { ConfigTranslateError } from "@lando/sdk/errors";
import { parseLegacyLandofile } from "@lando/sdk/landofile";
import type {
  ConfigTranslateDetectInput,
  ConfigTranslateDiagnostic,
  ConfigTranslateDocument,
  ConfigTranslateInput,
  ConfigTranslateResult,
  ConfigTranslateSourceId,
  LandofileLayer,
} from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import type { ConfigTranslatorShape } from "@lando/sdk/services";

import {
  LANDO3_TRANSLATOR_ID,
  type Lando3Source,
  type Lando3TranslatorPorts,
  type MergedLegacyValue,
  lando3SourceLayerOrder,
  lando3TargetLayer,
} from "./contract.ts";
import { detectLando3, isAppRootLando3Layer, sourceLayerForDocument } from "./detect.ts";
import { dedupeDiagnostics, orderDiagnostics } from "./diagnostics.ts";
import { foldToTargetLayers, legacyPrefixViews } from "./effective-views.ts";
import { mergeLegacySources, mergedToPlain, occurrencesAt, toMergedValue } from "./legacy-merge.ts";
import { legacyReferenceDiagnostics } from "./legacy-references.ts";
import { lowerAppNames } from "./lower-top-level.ts";
import type { V4Wire } from "./lowering-contract.ts";
import { decodeLando3Landofile } from "./model.ts";
import {
  type EstablishedLayer,
  type EstablishedRecipe,
  lowerRecipeViews,
  recipeLayerOutputs,
} from "./recipe-lowering.ts";
import { spanOf } from "./service-diagnostics.ts";
import { lowerServiceViews } from "./service-lowering.ts";
import { topLevelDispositions, unknownKeyDiagnostics } from "./top-level-dispositions.ts";
import { isPlainRecord, mergeLandofiles, v4LayerRank } from "./v4-merge.ts";

const YAML_MEDIA_TYPES = new Set(["application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml"]);

export const defaultLando3Ports = (): Lando3TranslatorPorts => ({
  decomposers: new Map(),
  redactor: createRedactor("secrets"),
});

const translateError = (message: string, remediation: string): ConfigTranslateError =>
  new ConfigTranslateError({ message, translator: LANDO3_TRANSLATOR_ID, remediation });

const parseSource =
  (ports: Lando3TranslatorPorts) =>
  (document: ConfigTranslateDocument): Effect.Effect<Lando3Source, ConfigTranslateError> =>
    Effect.gen(function* () {
      const file = document.path ?? String(document.sourceId);
      if (!YAML_MEDIA_TYPES.has(document.mediaType)) {
        return yield* Effect.fail(
          translateError(
            `${file} is ${document.mediaType}, which is not a Lando 3 Landofile.`,
            "Select only YAML Lando 3 layers for conversion.",
          ),
        );
      }
      const layer = sourceLayerForDocument(document);
      const parsed = yield* parseLegacyLandofile({
        mode: "legacy",
        file,
        content: new TextDecoder().decode(document.bytes),
      }).pipe(
        Effect.mapError((cause) =>
          translateError(
            // Parser messages quote the offending source text. The secrets
            // profile cannot see an arbitrary credential, so the message stays
            // file and line only.
            ports.redactor.redactString(
              `Failed to read the Lando 3 layer ${file}${cause.line === undefined ? "" : ` at line ${cause.line}`}.`,
            ),
            `Repair ${file} and run the conversion again.`,
          ),
        ),
      );
      return {
        sourceId: document.sourceId,
        layer,
        file,
        value: toMergedValue({ document: parsed, sourceId: document.sourceId, layer }),
      };
    });

const orphanConfigDiagnostic = (
  merged: MergedLegacyValue | undefined,
  fallback: ConfigTranslateSourceId,
): ReadonlyArray<ConfigTranslateDiagnostic> => {
  if (merged?.kind !== "mapping" || !merged.entries.has("config")) return [];
  const occurrence = occurrencesAt(merged, ["config"]).at(-1);
  return [
    {
      kind: "unsupported",
      sourceId: occurrence?.sourceId ?? fallback,
      keyPath: ["config"],
      span: spanOf(occurrence),
      message: "config has no Lando 3 recipe to apply to.",
      remediation: "Add a recipe, or remove config and author the Lando 4 services directly.",
    },
  ];
};

const withoutAppName = (fragment: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const { name: _name, ...rest } = fragment;
  return rest;
};

const persistedOptions = (value: unknown): Readonly<Record<string, string | boolean>> | undefined => {
  if (!isPlainRecord(value)) return undefined;
  const options: Record<string, string | boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string" && typeof entry !== "boolean") return undefined;
    options[key] = entry;
  }
  return options;
};

/**
 * Effective recipe after every established file. Each file is a delta, so id
 * and options accumulate low-to-high instead of trusting the highest file.
 */
const establishedRecipe = (layers: ReadonlyArray<EstablishedLayer>): EstablishedRecipe | undefined => {
  let recipeId: string | undefined;
  const options: Record<string, string | boolean> = {};
  let fragment: Readonly<Record<string, unknown>> = {};
  let sawRecipe = false;
  for (const layer of layers) {
    fragment = mergeLandofiles([fragment, layer.fragment]);
    const recipe = layer.fragment.recipe;
    if (!isPlainRecord(recipe)) continue;
    sawRecipe = true;
    if (typeof recipe.id === "string") recipeId = recipe.id;
    const next = persistedOptions(recipe.options);
    if (next !== undefined) Object.assign(options, next);
  }
  if (!sawRecipe || recipeId === undefined) return undefined;
  return { recipeId, options, fragment };
};

const establishedLayers = (
  fragments: ReadonlyArray<{ readonly layerId: LandofileLayer; readonly fragment: unknown }>,
  layers: ReadonlyArray<ConfigTranslateDocument>,
): ReadonlyArray<EstablishedLayer> =>
  [...fragments]
    .sort((left, right) => v4LayerRank(left.layerId) - v4LayerRank(right.layerId))
    .flatMap((fragment): EstablishedLayer[] => {
      if (!isPlainRecord(fragment.fragment)) return [];
      return [
        {
          layer: fragment.layerId,
          sourceIds: layers
            .filter((document) => lando3TargetLayer(sourceLayerForDocument(document)) === fragment.layerId)
            .map((document) => document.sourceId),
          fragment: withoutAppName(fragment.fragment),
        },
      ];
    });

/**
 * Builds the frontend over host-supplied ports. Recipe decomposition arrives
 * this way so the package never grows a second recipe expansion, and redaction
 * arrives this way so a host can widen it with values only the host knows.
 */
export const makeLando3ConfigTranslator = (ports: Lando3TranslatorPorts): ConfigTranslatorShape => {
  return {
    id: LANDO3_TRANSLATOR_ID,
    summary: "Lando 3 Landofile set decoder.",
    inputKinds: [LANDO3_TRANSLATOR_ID],

    detect: (input: ConfigTranslateDetectInput) => detectLando3(input),

    translate: (input: ConfigTranslateInput): Effect.Effect<ConfigTranslateResult, ConfigTranslateError> =>
      Effect.gen(function* () {
        if (input._tag === "recipe-request") {
          return yield* Effect.fail(
            translateError(
              "The Lando 3 frontend converts Landofile sets, not recipe requests.",
              "Select the recipe translator for a recipe request.",
            ),
          );
        }

        const layers = input.documents.filter(isAppRootLando3Layer);
        const established = establishedLayers(input.currentLowerV4Fragments, layers);
        const establishedTargets = new Set(established.map((layer) => layer.layer));
        const legacyLayers = layers.filter(
          (document) => !establishedTargets.has(lando3TargetLayer(sourceLayerForDocument(document))),
        );
        const sources = yield* Effect.forEach(legacyLayers, parseSource(ports));
        const merged = mergeLegacySources(sources);
        const folded = foldToTargetLayers(legacyPrefixViews(sources));
        const lowered = yield* lowerRecipeViews(ports, folded, establishedRecipe(established));
        const recipeFragments = [
          ...lowered.prefixes.map(({ fragment }) => fragment),
          ...established.map(({ fragment }) => fragment),
        ];
        const recipeServiceWires = new Map<string, V4Wire>();
        const serviceHolders = [
          ...[...established].sort((left, right) => v4LayerRank(left.layer) - v4LayerRank(right.layer)),
          ...lowered.prefixes,
        ];
        for (const { fragment } of serviceHolders) {
          if (!isPlainRecord(fragment.services)) continue;
          for (const [name, service] of Object.entries(fragment.services)) {
            if (!isPlainRecord(service)) continue;
            const current = recipeServiceWires.get(name);
            if (
              current === undefined ||
              !Array.isArray(current.endpoints) ||
              Array.isArray(service.endpoints)
            ) {
              recipeServiceWires.set(name, service);
            }
          }
        }
        const authored = lowerServiceViews(folded, {
          tools: new Set(
            recipeFragments.flatMap(({ tooling }) => (isPlainRecord(tooling) ? Object.keys(tooling) : [])),
          ),
          recipeServices: [...recipeServiceWires.keys()],
          recipeServiceWires,
        });
        const decoded = decodeLando3Landofile(mergedToPlain(merged));

        const writable = new Set<LandofileLayer>(input.writableLayerIds);
        const planned = recipeLayerOutputs(
          folded,
          lowered,
          lowerAppNames(sources, writable),
          established,
          authored.prefixes,
        );
        const missing = planned.required.filter((layer) => !writable.has(layer));
        if (input.mode === "single-layer" && missing.length > 0) {
          return yield* Effect.fail(
            translateError(
              "The conversion needs edits outside the writable layers.",
              `This layer's conversion also needs edits to ${missing.join(", ")}; run the full conversion instead of --file.`,
            ),
          );
        }
        const outputs = planned.outputs;

        const fallback = layers[0]?.sourceId;
        if (fallback === undefined) {
          return { outputs: [], diagnostics: [], deletions: [] };
        }

        const ranks = new Map(
          sources.map((source) => [source.sourceId, lando3SourceLayerOrder(source.layer)]),
        );
        const recipePresent =
          establishedRecipe(established) !== undefined || folded.some((view) => view.recipe !== undefined);
        const diagnostics = orderDiagnostics(
          dedupeDiagnostics([
            ...topLevelDispositions(merged, fallback),
            ...legacyReferenceDiagnostics(merged, fallback),
            ...(recipePresent ? [] : orphanConfigDiagnostic(merged, fallback)),
            ...unknownKeyDiagnostics(decoded.unknownKeys, merged, fallback),
            ...planned.diagnostics,
            ...authored.diagnostics,
          ]),
          (sourceId) => ranks.get(sourceId) ?? 0,
        );

        return { outputs, diagnostics, deletions: [] };
      }),
  };
};

export const lando3ConfigTranslator: ConfigTranslatorShape = makeLando3ConfigTranslator(defaultLando3Ports());
