import type { LegacyOccurrence, MergedLegacyValue } from "./contract.ts";
import { occurrencesAt } from "./legacy-merge.ts";

export type RecipeOptionSpec =
  | { readonly kind: "enum"; readonly values: ReadonlyArray<string> }
  | { readonly kind: "boolean" }
  | { readonly kind: "string" };

export interface RecipeOptionMap {
  readonly recipeId: string;
  readonly options: Readonly<Record<string, RecipeOptionSpec>>;
  readonly defaults: Readonly<Record<string, string | boolean>>;
  /** Lando 3 config key -> Lando 4 option name. */
  readonly renames: Readonly<Record<string, string>>;
}

export const PHP_VERSIONS: ReadonlyArray<string> = ["8.1", "8.2", "8.3", "8.4", "8.5", "8.6"];
const enumeration = (values: ReadonlyArray<string>): RecipeOptionSpec => ({ kind: "enum", values });
const composerRename = { composer_version: "composer" } as const;
const lampOptions = {
  options: {
    php: enumeration(PHP_VERSIONS),
    database: enumeration(["mariadb:11.4", "mysql:8.0"]),
    composer: enumeration(["2", "2.7.7", "false"]),
    webroot: { kind: "string" },
  },
  defaults: { php: "8.3", database: "mariadb:11.4", composer: "2", webroot: "/app" },
  renames: composerRename,
} as const;
const drupalVersions = ["11", "10"] as const;

// Deliberately local: the legacy translator may depend only on SDK contracts,
// not on core's recipe snapshots. Keep this closed table in sync with those options.
export const BUNDLED_RECIPE_OPTION_MAPS: ReadonlyMap<string, RecipeOptionMap> = new Map<
  string,
  RecipeOptionMap
>([
  [
    "drupal",
    {
      recipeId: "drupal",
      options: {
        drupal: enumeration(drupalVersions),
        php: enumeration(PHP_VERSIONS),
        webserver: enumeration(["apache", "nginx"]),
        database: enumeration(["mariadb:11.4", "mysql:8.0", "postgres:16"]),
        composer: enumeration(["2", "2.7.7"]),
        webroot: { kind: "string" },
      },
      defaults: {
        drupal: "11",
        php: "8.3",
        webserver: "apache",
        database: "mariadb:11.4",
        composer: "2",
        webroot: "/app/web",
      },
      renames: { ...composerRename, via: "webserver" },
    },
  ],
  [
    "wordpress",
    {
      recipeId: "wordpress",
      options: { php: enumeration(["8.2", "8.3"]), redis: { kind: "boolean" } },
      defaults: { php: "8.3", redis: false },
      renames: composerRename,
    },
  ],
  ["lamp", { recipeId: "lamp", ...lampOptions }],
  [
    "lemp",
    {
      recipeId: "lemp",
      options: { php: enumeration(["8.2", "8.3"]) },
      defaults: { php: "8.3" },
      renames: composerRename,
    },
  ],
  [
    "laravel",
    {
      recipeId: "laravel",
      options: {
        php: enumeration(PHP_VERSIONS),
        database: enumeration(["mariadb:11.4", "postgres:16"]),
        composer: enumeration(["2", "2.7.7"]),
        webroot: { kind: "string" },
        worker: { kind: "boolean" },
      },
      defaults: {
        php: "8.3",
        database: "mariadb:11.4",
        composer: "2",
        webroot: "/app/public",
        worker: false,
      },
      renames: composerRename,
    },
  ],
  [
    "symfony",
    {
      recipeId: "symfony",
      options: {
        php: enumeration(PHP_VERSIONS),
        database: enumeration(["postgres:16", "mariadb:11.4"]),
        composer: enumeration(["2", "2.7.7"]),
        webroot: { kind: "string" },
      },
      defaults: { php: "8.3", database: "postgres:16", composer: "2", webroot: "/app/public" },
      renames: composerRename,
    },
  ],
  ["backdrop", { recipeId: "backdrop", ...lampOptions }],
  ["joomla", { recipeId: "joomla", ...lampOptions }],
  [
    "mean",
    {
      recipeId: "mean",
      options: { node: enumeration(["lts", "22"]), redis: { kind: "boolean" } },
      defaults: { node: "lts", redis: false },
      renames: {},
    },
  ],
]);

export const HOSTER_RECIPE_IDS: ReadonlySet<string> = new Set(["pantheon", "platformsh", "lagoon", "acquia"]);
/** Lando 3 id -> v4 id plus pinned options the id itself implies. */
export const LEGACY_RECIPE_ALIASES: ReadonlyMap<
  string,
  { readonly recipeId: string; readonly pinned: Readonly<Record<string, string>> }
> = new Map([
  ["drupal10", { recipeId: "drupal", pinned: { drupal: "10" } }],
  ["drupal11", { recipeId: "drupal", pinned: { drupal: "11" } }],
]);

export type RecipeClassification =
  | {
      readonly _tag: "supported";
      readonly recipeId: string;
      readonly legacyId: string;
      readonly pinned: Readonly<Record<string, string>>;
      readonly map: RecipeOptionMap;
    }
  | {
      readonly _tag: "unsupported";
      readonly legacyId: string;
      readonly reason: "hoster" | "unknown" | "non-string" | "no-v4-version";
    };

const valueDescription = (value: MergedLegacyValue): string => {
  switch (value.kind) {
    case "scalar":
      return String(value.value);
    case "tagged":
      return value.tag;
    case "mapping":
      return "mapping";
    case "sequence":
      return "sequence";
  }
};

export const classifyRecipe = (recipe: MergedLegacyValue | undefined): RecipeClassification | undefined => {
  if (recipe === undefined) return undefined;
  if (recipe.kind !== "scalar" || typeof recipe.value !== "string") {
    return { _tag: "unsupported", legacyId: valueDescription(recipe), reason: "non-string" };
  }
  const legacyId = recipe.value;
  if (HOSTER_RECIPE_IDS.has(legacyId)) return { _tag: "unsupported", legacyId, reason: "hoster" };
  const major = /^drupal([0-9]+)$/.exec(legacyId)?.[1];
  if (major !== undefined && !drupalVersions.some((version) => version === major)) {
    return { _tag: "unsupported", legacyId, reason: "no-v4-version" };
  }
  const alias = LEGACY_RECIPE_ALIASES.get(legacyId);
  const recipeId = alias?.recipeId ?? legacyId;
  const map = BUNDLED_RECIPE_OPTION_MAPS.get(recipeId);
  return map === undefined
    ? { _tag: "unsupported", legacyId, reason: "unknown" }
    : { _tag: "supported", recipeId, legacyId, pinned: alias?.pinned ?? {}, map };
};

export interface MappedConfigEntry {
  readonly legacyKey: string;
  readonly occurrences: ReadonlyArray<LegacyOccurrence>;
}
export interface MappedOptions {
  readonly options: Readonly<Record<string, string | boolean>>;
  readonly dropped: ReadonlyArray<MappedConfigEntry>;
  readonly invalid: ReadonlyArray<
    MappedConfigEntry & { readonly option: string; readonly spec: RecipeOptionSpec; readonly value: string }
  >;
  /** Set when config is a tag, so callers fail closed instead of using defaults. */
  readonly blocked: MappedConfigEntry | undefined;
}

const coerceOption = (value: MergedLegacyValue, spec: RecipeOptionSpec): string | boolean | undefined => {
  if (value.kind !== "scalar" || value.value === null) return undefined;
  // Spans contain positions, not source text. Numeric spelling (8.10 vs 8.1)
  // cannot be recovered here: use String(value), with no further normalization.
  // Quoted strings retain their exact spelling and are checked unchanged.
  const candidate = String(value.value);
  switch (spec.kind) {
    case "boolean":
      return typeof value.value === "boolean" ? value.value : undefined;
    case "enum":
      return spec.values.includes(candidate) ? candidate : undefined;
    case "string":
      return candidate.length > 0 ? candidate : undefined;
  }
};

export const mapConfigOptions = (
  classification: Extract<RecipeClassification, { _tag: "supported" }>,
  config: MergedLegacyValue | undefined,
  baseOptions?: Readonly<Record<string, string | boolean>>,
): MappedOptions => {
  const { map, pinned } = classification;
  const options = { ...map.defaults, ...pinned, ...baseOptions };
  const dropped: MappedConfigEntry[] = [];
  const invalid: Array<MappedOptions["invalid"][number]> = [];
  // A tagged config is a file reference. Defaults would hide it, and this translator does not read the file.
  if (config?.kind === "tagged") {
    return {
      options: Object.fromEntries(Object.entries(options).sort()),
      dropped,
      invalid,
      blocked: { legacyKey: "config", occurrences: occurrencesAt(config, []) },
    };
  }
  if (config?.kind === "mapping") {
    for (const [legacyKey, value] of config.entries) {
      const option =
        (Object.hasOwn(map.renames, legacyKey) ? map.renames[legacyKey] : undefined) ?? legacyKey;
      const direct = occurrencesAt(config, [legacyKey]);
      const occurrences = direct.length > 0 ? direct : occurrencesAt(config, []);
      const spec = Object.hasOwn(map.options, option) ? map.options[option] : undefined;
      if (spec === undefined) {
        dropped.push({ legacyKey, occurrences });
        continue;
      }
      const accepted = coerceOption(value, spec);
      if (accepted === undefined) {
        invalid.push({ legacyKey, occurrences, option, spec, value: valueDescription(value) });
      } else {
        options[option] = accepted;
      }
    }
  }
  return {
    options: Object.fromEntries(Object.entries(options).sort()),
    dropped,
    invalid,
    blocked: undefined,
  };
};
