import { LandofileAuthoringFragment, LandofileAuthoringFragmentNative, ServiceName } from "@lando/sdk/schema";
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
import { Effect, Schema } from "effect";

import { ConfigTranslateError } from "@lando/sdk/errors";
import {
  decodeLandofileAuthoringLayer,
  isPlainRecord,
  landofileLayerRank,
  mergeLandofiles,
} from "@lando/sdk/landofile";
import type {
  ConfigTranslateDetectInput,
  ConfigTranslateDocument,
  ConfigTranslateInput,
  ConfigTranslateResult,
  LandofileLayer,
} from "@lando/sdk/schema";
import type { ConfigTranslatorShape } from "@lando/sdk/services";

import { completeLando3CommitSet } from "./commit-set.ts";
import {
  LANDO3_TRANSLATOR_ID,
  type Lando3TranslatorPorts,
  lando3SourceLayerOrder,
  lando3TargetLayer,
} from "./contract.ts";
import { detectLando3, isAppRootLando3Layer, sourceLayerForDocument } from "./detect.ts";
import { dedupeDiagnostics, orderDiagnostics } from "./diagnostics.ts";
import { foldToTargetLayers, legacyPrefixViews } from "./effective-views.ts";
import { mergeLegacySources, mergedToPlain, occurrencesAt } from "./legacy-merge.ts";
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
import { lowerServiceViews } from "./service-lowering.ts";
import {
  orphanConfigDiagnostic,
  topLevelDispositions,
  unknownKeyDiagnostics,
} from "./top-level-dispositions.ts";
import { parseSource, translateError } from "./translator-source.ts";

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
  let options: Record<string, string | boolean> = {};
  let fragment: Readonly<Record<string, unknown>> = {};
  let sawRecipe = false;
  for (const layer of layers) {
    fragment = mergeLandofiles([fragment, layer.fragment]);
    const recipe = fragment.recipe;
    if (!isPlainRecord(recipe)) continue;
    sawRecipe = true;
    if (typeof recipe.id === "string") recipeId = recipe.id;
    const next = persistedOptions(recipe.options);
    if (next !== undefined) options = { ...next };
  }
  if (!sawRecipe || recipeId === undefined) return undefined;
  return { recipeId, options, fragment };
};

const establishedLayers = (
  fragments: ReadonlyArray<{ readonly layerId: LandofileLayer; readonly fragment: unknown }>,
  layers: ReadonlyArray<ConfigTranslateDocument>,
): ReadonlyArray<EstablishedLayer> =>
  [...fragments]
    .sort((left, right) => landofileLayerRank(left.layerId) - landofileLayerRank(right.layerId))
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

    translate: Effect.fn("Lando3ConfigTranslator.translate")(function* (
      input: ConfigTranslateInput,
    ): Effect.fn.Return<ConfigTranslateResult, ConfigTranslateError> {
      if (input._tag === "recipe-request") {
        return yield* Effect.fail(
          translateError(
            "The Lando 3 frontend converts Landofile sets, not recipe requests.",
            "Select the recipe translator for a recipe request.",
          ),
        );
      }

      const layers = input.documents.filter(isAppRootLando3Layer);
      const lowerFragments = yield* Effect.forEach(input.currentLowerV4Fragments, (entry) =>
        Schema.decodeUnknownEffect(LandofileAuthoringFragment)(entry.fragment, {
          onExcessProperty: "error",
        }).pipe(
          Effect.flatMap((value) =>
            Schema.encodeEffect(LandofileAuthoringFragmentNative)(value, { onExcessProperty: "error" }),
          ),
          Effect.tap((value) => decodeLandofileAuthoringLayer(entry.layerId, value)),
          Effect.map((fragment) => ({ layerId: entry.layerId, fragment })),
          Effect.mapError(
            (cause) =>
              new ConfigTranslateError({
                message: "Invalid established Landofile fragment.",
                cause,
                remediation:
                  "Repair the established v4 Landofile fragment so it validates, then retry conversion.",
              }),
          ),
        ),
      );
      const established = establishedLayers(lowerFragments, layers);
      const establishedTargets = new Set(established.map((layer) => layer.layer));
      const legacyLayers = layers.filter(
        (document) => !establishedTargets.has(lando3TargetLayer(sourceLayerForDocument(document))),
      );
      const sources = yield* Effect.forEach(legacyLayers, parseSource(ports));
      const merged = mergeLegacySources(sources);
      const prefixes = legacyPrefixViews(sources);
      const folded = foldToTargetLayers(prefixes);
      const lowered = yield* lowerRecipeViews(ports, folded, establishedRecipe(established));
      const recipeFragments = [
        ...lowered.prefixes.map(({ fragment }) => fragment),
        ...established.map(({ fragment }) => fragment),
      ];
      const recipeServiceWires = new Map<string, V4Wire>();
      const serviceHolders = [
        ...[...established].sort(
          (left, right) => landofileLayerRank(left.layer) - landofileLayerRank(right.layer),
        ),
        ...lowered.prefixes,
      ];
      for (const { fragment } of serviceHolders) {
        const services = mergeLandofiles([fragment]).services;
        if (!isPlainRecord(services)) continue;
        for (const [name, service] of Object.entries(services)) {
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
      const authored = lowerServiceViews(folded, ports.serviceFacts, {
        tools: new Set(
          recipeFragments.flatMap((fragment) => {
            const tooling = mergeLandofiles([fragment]).tooling;
            return isPlainRecord(tooling) ? Object.keys(tooling) : [];
          }),
        ),
        recipeServices: [...recipeServiceWires.keys()],
        recipeServiceWires,
      });
      const decoded = decodeLando3Landofile(mergedToPlain(merged));

      const writable = new Set<LandofileLayer>(input.writableLayerIds);
      const planned = yield* recipeLayerOutputs(
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
      const { outputs, deletions } = completeLando3CommitSet(input, planned.outputs);

      const fallback = layers[0]?.sourceId;
      if (fallback === undefined) {
        return { outputs: [], diagnostics: [], deletions: [] };
      }

      const ranks = new Map(sources.map((source) => [source.sourceId, lando3SourceLayerOrder(source.layer)]));
      const recipePresent =
        establishedRecipe(established) !== undefined || folded.some((view) => view.recipe !== undefined);
      const diagnostics = orderDiagnostics(
        dedupeDiagnostics([
          ...topLevelDispositions(merged, fallback),
          ...legacyReferenceDiagnostics(merged, fallback),
          ...(recipePresent ? [] : orphanConfigDiagnostic(merged, fallback)),
          ...planned.diagnostics,
          ...authored.diagnostics,
          ...prefixes.flatMap(({ merged }) =>
            unknownKeyDiagnostics(decodeLando3Landofile(mergedToPlain(merged)).unknownKeys, merged, fallback),
          ),
          ...unknownKeyDiagnostics(decoded.unknownKeys, merged, fallback),
        ]),
        (sourceId) => ranks.get(sourceId) ?? 0,
      );

      const outputServices = new Set(
        outputs.flatMap(({ fragment }) =>
          isPlainRecord(fragment) && isPlainRecord(fragment.services) ? Object.keys(fragment.services) : [],
        ),
      );
      const legacy = mergedToPlain(merged);
      const authoredServices = isPlainRecord(legacy) && isPlainRecord(legacy.services) ? legacy.services : {};
      const recipeSource = occurrencesAt(merged, ["recipe"]).at(-1)?.sourceId ?? fallback;
      const expectations = [
        ...authored.expectations,
        ...[...recipeServiceWires.keys()]
          .filter((name) => !Object.hasOwn(authoredServices, name))
          .map((name) => ({
            _tag: "PersistedHome" as const,
            sourceId: recipeSource,
            keyPath: ["recipe"],
            service: ServiceName.make(name),
          })),
      ].filter(({ service }) => outputServices.has(service));
      return { outputs, diagnostics, deletions, expectations };
    }),
  };
};
