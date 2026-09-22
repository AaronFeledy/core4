import { isLegacyTagged, parseLegacyLandofile } from "@lando/sdk/landofile";
import type {
  ConfigTranslateDetectInput,
  ConfigTranslateDocument,
  ConfigTranslateMatch,
} from "@lando/sdk/schema";
import { Effect, Either } from "effect";
import {
  LANDO3_LAYER_BASENAMES,
  LANDO3_SOURCE_LAYERS,
  LANDO3_TRANSLATOR_ID,
  type Lando3SourceLayer,
} from "./contract.ts";

export { LANDO3_TRANSLATOR_ID } from "./contract.ts";

export type Lando3Signal =
  | "recipe-config"
  | "service-api-3"
  | "nested-services"
  | "service-overrides"
  | "build-as-root"
  | "run-as-root"
  | "build-internal"
  | "run-internal"
  | "tooling-options"
  | "tooling-service-commands"
  | "service-portforward"
  | "proxy-string"
  | "compose"
  | "plugin-dirs"
  | "plugins"
  | "excludes"
  | "recipe-layer";

const YAML_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "application/yaml",
  "application/x-yaml",
  "text/yaml",
  "text/x-yaml",
]);
const RECIPE_LAYER: Lando3SourceLayer = "recipe";
const documentBasename = (document: ConfigTranslateDocument): string | undefined =>
  (document.path ?? String(document.sourceId)).replace(/\\/gu, "/").split("/").at(-1);

export const sourceLayerForDocument = (document: ConfigTranslateDocument): Lando3SourceLayer => {
  const basename = documentBasename(document);
  const namedLayer = LANDO3_LAYER_BASENAMES.find(
    ([, stem]) => basename === `${stem}.yml` || basename === `${stem}.yaml`,
  );
  return namedLayer?.[0] ?? LANDO3_SOURCE_LAYERS.find((layer) => layer === document.layerId) ?? "canonical";
};

const LANDO3_LAYER_FILES: ReadonlySet<string> = new Set(
  LANDO3_LAYER_BASENAMES.map(([, stem]) => `${stem}.yml`),
);

/**
 * Membership in the Lando 3 document set: the seven app-root `.yml` layers.
 * Core discovery also supplies compose files, JSON, `.yaml`, and nested apps.
 * Those are not layers, so translation must not parse or merge them.
 */
export const isAppRootLando3Layer = (document: ConfigTranslateDocument): boolean => {
  const name = (document.path ?? String(document.sourceId)).replace(/\\/gu, "/");
  return LANDO3_LAYER_FILES.has(name);
};
const SERVICE_KEYS = [
  ["overrides", "service-overrides"],
  ["build_as_root", "build-as-root"],
  ["run_as_root", "run-as-root"],
  ["build_internal", "build-internal"],
  ["run_internal", "run-internal"],
  ["portforward", "service-portforward"],
] as const satisfies ReadonlyArray<readonly [string, Lando3Signal]>;
const WEAK_KEYS = [
  ["compose", "compose"],
  ["pluginDirs", "plugin-dirs"],
  ["plugins", "plugins"],
  ["excludes", "excludes"],
] as const satisfies ReadonlyArray<readonly [string, Lando3Signal]>;

// These four top-level keys can survive hand migration, so alone they are only
// likely. Every other signal is a legacy structural spelling or recipe-layer
// filename and is exact; neither catalog versions nor a missing runtime qualify.
const WEAK_SIGNALS: ReadonlySet<Lando3Signal> = new Set(WEAK_KEYS.map(([, signal]) => signal));

const isMapping = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !isLegacyTagged(value);
const mappings = (value: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> =>
  isMapping(value) ? Object.values(value).filter(isMapping) : [];
const isServiceCommand = (value: unknown): boolean => {
  if (!isMapping(value)) return false;
  const values = Object.values(value);
  const command = values[0];
  return (
    values.length === 1 &&
    (typeof command === "string" ||
      (isLegacyTagged(command) &&
        typeof command.value === "string" &&
        (command.tag === "!load" || command.tag === "!import")))
  );
};

/** Pure snapshot inspection: the synchronous legacy parser retains tags as data. */
export const lando3Signals = (document: ConfigTranslateDocument): ReadonlyArray<Lando3Signal> => {
  if (!YAML_MEDIA_TYPES.has(document.mediaType)) return [];
  const file = document.path ?? String(document.sourceId);
  const parsed = Effect.runSync(
    parseLegacyLandofile({
      mode: "legacy",
      file,
      content: new TextDecoder().decode(document.bytes),
    }).pipe(Effect.either),
  );
  if (Either.isLeft(parsed)) return [];

  const signals = new Set<Lando3Signal>();
  const root = parsed.right.value;
  if (isMapping(root)) {
    if (Object.hasOwn(root, "recipe") && Object.hasOwn(root, "config")) signals.add("recipe-config");
    for (const service of mappings(root.services)) {
      if (service.api === 3) signals.add("service-api-3");
      // Omitted api defaults to 3 in legacy raw services; explicit api 4 must
      // never be reclassified merely because a nested services key exists.
      if (
        (service.api === 3 || !Object.hasOwn(service, "api")) &&
        (service.type === "lando" || service.type === "compose") &&
        isMapping(service.services)
      ) {
        signals.add("nested-services");
      }
      for (const [key, signal] of SERVICE_KEYS) if (Object.hasOwn(service, key)) signals.add(signal);
    }
    for (const tooling of mappings(root.tooling)) {
      if (Object.hasOwn(tooling, "options")) signals.add("tooling-options");
      // Empty arrays and ordinary argv lists are ambiguous, not legacy proof.
      if (Array.isArray(tooling.cmd) && tooling.cmd.length > 0 && tooling.cmd.every(isServiceCommand)) {
        signals.add("tooling-service-commands");
      }
    }
    if (
      isMapping(root.proxy) &&
      Object.values(root.proxy).some(
        (routes) => Array.isArray(routes) && routes.some((route: unknown) => typeof route === "string"),
      )
    ) {
      signals.add("proxy-string");
    }
    for (const [key, signal] of WEAK_KEYS) if (Object.hasOwn(root, key)) signals.add(signal);
  }
  const basename = documentBasename(document);
  if (LANDO3_LAYER_BASENAMES.some(([layer, stem]) => layer === RECIPE_LAYER && basename === `${stem}.yml`)) {
    signals.add("recipe-layer");
  }
  return [...signals];
};

export const detectLando3 = (
  input: ConfigTranslateDetectInput,
): Effect.Effect<ReadonlyArray<ConfigTranslateMatch>, never> =>
  Effect.sync(() => {
    const matched = input.documents
      .map((document) => ({ document, signals: lando3Signals(document) }))
      .filter(({ signals }) => signals.length > 0);
    if (matched.length === 0) return [];
    const signals = [...new Set(matched.flatMap((entry) => entry.signals))];
    return [
      {
        translator: LANDO3_TRANSLATOR_ID,
        sourceIds: matched.map(({ document }) => document.sourceId),
        confidence: signals.some((signal) => !WEAK_SIGNALS.has(signal)) ? "exact" : "likely",
        summary: `Lando 3 signals: ${signals.join(", ")}.`,
      },
    ];
  });
