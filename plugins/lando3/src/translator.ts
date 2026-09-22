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
 * Service keys whose Lando 4 target waits on work that has not landed are
 * `dropped`, and the remediation names that story, so they never block
 * conversion. Top-level sections that still have no lowerer stay
 * `unsupported` and block the write until that section is built. Nothing is
 * ever silently omitted.
 */
import { Effect } from "effect";

import { ConfigTranslateError } from "@lando/sdk/errors";
import { parseLegacyLandofile } from "@lando/sdk/landofile";
import type {
  ConfigTranslateDetectInput,
  ConfigTranslateDiagnostic,
  ConfigTranslateDocument,
  ConfigTranslateInput,
  ConfigTranslateOutput,
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
  type LegacyOccurrence,
  type MergedLegacyValue,
  lando3SourceLayerOrder,
  lando3TargetLayer,
} from "./contract.ts";
import { detectLando3, isAppRootLando3Layer, sourceLayerForDocument } from "./detect.ts";
import { dedupeDiagnostics, orderDiagnostics } from "./diagnostics.ts";
import { foldToTargetLayers, legacyPrefixViews } from "./effective-views.ts";
import { mergeLegacySources, mergedToPlain, occurrencesAt, toMergedValue } from "./legacy-merge.ts";
import { decodeLando3Landofile } from "./model.ts";
import { slugifyAppName } from "./naming.ts";
import {
  type EstablishedLayer,
  type EstablishedRecipe,
  lowerRecipeViews,
  recipeLayerOutputs,
} from "./recipe-lowering.ts";
import { lowerServiceViews } from "./service-lowering.ts";
import { formatPath } from "./source.ts";
import { isPlainRecord, mergeLandofiles, v4LayerRank } from "./v4-merge.ts";

const YAML_MEDIA_TYPES = new Set(["application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml"]);

/**
 * Lando 3 custom-Landofile settings. They are diagnosed where an author
 * supplied them and never honored: resolving one would mean reading user
 * state, which this package does not do.
 */
const CUSTOM_BASENAME_KEYS = ["landoFile", "preLandoFiles", "postLandoFiles"] as const;

const LOWERED_KEYS = new Set<string>([
  "name",
  "recipe",
  "config",
  "services",
  "compose",
  "excludes",
  "env_file",
  "volumes",
  "networks",
  "plugins",
  "pluginDirs",
  "keys",
]);

export const defaultLando3Ports = (): Lando3TranslatorPorts => ({
  decomposers: new Map(),
  redactor: createRedactor("secrets"),
});

const translateError = (message: string, remediation: string): ConfigTranslateError =>
  new ConfigTranslateError({ message, translator: LANDO3_TRANSLATOR_ID, remediation });

const decodeDocument = (document: ConfigTranslateDocument): string =>
  new TextDecoder().decode(document.bytes);

const documentLabel = (document: ConfigTranslateDocument): string =>
  document.path ?? String(document.sourceId);

const parseSource =
  (ports: Lando3TranslatorPorts) =>
  (document: ConfigTranslateDocument): Effect.Effect<Lando3Source, ConfigTranslateError> =>
    Effect.gen(function* () {
      const file = documentLabel(document);
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
        content: decodeDocument(document),
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

const lastOccurrence = (occurrences: ReadonlyArray<LegacyOccurrence>): LegacyOccurrence | undefined =>
  occurrences.at(-1);

const spanOf = (occurrence: LegacyOccurrence | undefined): ConfigTranslateDiagnostic["span"] =>
  occurrence?.span === undefined
    ? undefined
    : {
        start: { line: occurrence.span.start.line, column: occurrence.span.start.column },
        end: { line: occurrence.span.end.line, column: occurrence.span.end.column },
      };

const topLevelKeys = (merged: MergedLegacyValue | undefined): ReadonlyArray<string> =>
  merged?.kind === "mapping" ? [...merged.entries.keys()] : [];

const targetFor = (source: Lando3Source): LandofileLayer => lando3TargetLayer(source.layer);

const nameAssignments = (
  sources: ReadonlyArray<Lando3Source>,
): ReadonlyArray<{ readonly source: Lando3Source; readonly name: string }> =>
  sources.flatMap((source) => {
    const root = source.value;
    if (root?.kind !== "mapping") return [];
    const entry = root.entries.get("name");
    if (entry?.kind !== "scalar" || typeof entry.value !== "string") return [];
    return [{ source, name: entry.value }];
  });

const buildOutputs = (
  sources: ReadonlyArray<Lando3Source>,
  writable: ReadonlySet<LandofileLayer>,
): ReadonlyArray<ConfigTranslateOutput> => {
  const byTarget = new Map<
    LandofileLayer,
    { readonly sourceIds: Array<ConfigTranslateSourceId>; name: string; order: number }
  >();
  for (const { source, name } of nameAssignments(sources)) {
    const target = targetFor(source);
    if (!writable.has(target)) continue;
    const order = lando3SourceLayerOrder(source.layer);
    const existing = byTarget.get(target);
    if (existing === undefined) {
      byTarget.set(target, { sourceIds: [source.sourceId], name, order });
      continue;
    }
    existing.sourceIds.push(source.sourceId);
    // Two Lando 3 layers can fold onto one target. Later Lando 3 order wins,
    // exactly as it would have at load time.
    if (order >= existing.order) {
      existing.name = name;
      existing.order = order;
    }
  }
  return [...byTarget.entries()].map(([targetLayer, claim]) => ({
    targetLayer,
    fragment: { name: slugifyAppName(claim.name) },
    sourceIds: claim.sourceIds,
  }));
};

const configuredBasenames = (value: MergedLegacyValue | undefined): ReadonlyArray<string> => {
  if (value === undefined) return [];
  switch (value.kind) {
    case "scalar":
      return typeof value.value === "string" && value.value.length > 0 ? [value.value] : [];
    case "sequence":
      return value.items.flatMap((item) => configuredBasenames(item.value));
    case "tagged":
      return configuredBasenames(value.value);
    case "mapping":
      return [];
  }
};

const orphanConfigDiagnostic = (
  merged: MergedLegacyValue | undefined,
  fallback: ConfigTranslateSourceId,
): ReadonlyArray<ConfigTranslateDiagnostic> => {
  if (merged?.kind !== "mapping" || !merged.entries.has("config")) return [];
  const occurrence = lastOccurrence(occurrencesAt(merged, ["config"]));
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

const deferredDiagnostics = (
  merged: MergedLegacyValue | undefined,
  fallback: ConfigTranslateSourceId,
): ReadonlyArray<ConfigTranslateDiagnostic> =>
  topLevelKeys(merged)
    .filter((key) => !LOWERED_KEYS.has(key) && !key.startsWith("x-"))
    .map((key) => {
      const occurrence = lastOccurrence(occurrencesAt(merged, [key]));
      const custom = (CUSTOM_BASENAME_KEYS as ReadonlyArray<string>).includes(key);
      const names = custom
        ? configuredBasenames(merged?.kind === "mapping" ? merged.entries.get(key) : undefined)
        : [];
      const listed = names.length > 0 ? `: ${names.join(", ")}` : "";
      return {
        kind: custom ? ("needs-review" as const) : ("unsupported" as const),
        sourceId: occurrence?.sourceId ?? fallback,
        keyPath: [key],
        span: spanOf(occurrence),
        message: custom
          ? `${formatPath([key])} names custom Lando 3 Landofile basenames${listed}.`
          : `${formatPath([key])} has no Lando 4 target yet.`,
        remediation: custom
          ? "Rename the files to the standard Lando 4 basenames before converting; custom Landofile names are not honored."
          : `Author the Lando 4 equivalent of ${formatPath([key])} by hand, or convert again once this section is supported.`,
      };
    });

const unknownKeyDiagnostics = (
  unknownKeys: ReadonlyArray<ReadonlyArray<string | number>>,
  merged: MergedLegacyValue | undefined,
  fallback: ConfigTranslateSourceId,
): ReadonlyArray<ConfigTranslateDiagnostic> =>
  unknownKeys.map((keyPath) => {
    const occurrence = lastOccurrence(occurrencesAt(merged, keyPath));
    return {
      kind: "dropped" as const,
      sourceId: occurrence?.sourceId ?? fallback,
      keyPath: [...keyPath],
      span: spanOf(occurrence),
      message: `${formatPath(keyPath)} is not a Lando 3 key and was ignored by Lando 3 as well.`,
      remediation: `Remove ${formatPath(keyPath)}, or author the Lando 4 value you intended.`,
    };
  });

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
        const authored = lowerServiceViews(folded);
        const decoded = decodeLando3Landofile(mergedToPlain(merged));

        const writable = new Set<LandofileLayer>(input.writableLayerIds);
        const planned = recipeLayerOutputs(
          folded,
          lowered,
          buildOutputs(sources, writable),
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
            ...deferredDiagnostics(merged, fallback),
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
