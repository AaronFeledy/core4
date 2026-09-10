import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { LandofileFormConflictError, LandofileNotFoundError, LandofileParseError } from "@lando/sdk/errors";
import { type ExpressionNode, type ExpressionTemplate, parseExpressionEither } from "@lando/sdk/expressions";
import {
  isBareRecipeReference,
  renderRecipeSnapshot,
  validateLandofileRecipeProvenance,
} from "@lando/sdk/recipes";
import type { LandofileRecipeProvenance, RecipeOptionValue, RecipeSnapshot } from "@lando/sdk/schema";
import { sameRecipeVersion } from "@lando/sdk/schema";
import { Effect, Either } from "effect";

import { getAtPath } from "@lando/engine/config-write/dot-path";
import { findDiscoveredLandofilePath } from "@lando/engine/services/landofile-live";
import { parseLandofile } from "@lando/landofile/parser";

import { lookupRecipeSnapshot } from "../../recipes/builtin/snapshots.ts";
import type { AppConfigExplainResult, ExplainBlockedReason } from "./app-config-explain-output.ts";

export {
  AppConfigExplainResultSchema,
  ExplainBlockedReason,
  renderAppConfigExplainResult,
} from "./app-config-explain-output.ts";
export type { AppConfigExplainResult } from "./app-config-explain-output.ts";

export interface AppConfigExplainOptions {
  readonly cwd?: string;
}

export type AppConfigExplainError = LandofileNotFoundError | LandofileParseError;

const CANONICAL_LANDOFILE = ".lando.yml";
const PROGRAMMATIC_LANDOFILE = ".lando.ts";

type ExplainComparison = AppConfigExplainResult["comparison"];
type ExplainReference = AppConfigExplainResult["options"][number]["references"][number];
type ExplainTakenOverSite = AppConfigExplainResult["options"][number]["takenOver"][number];

/** One value site whose expression reads at least one `recipe.<option>`. */
interface RecipeSite {
  readonly path: string;
  readonly source: string;
  readonly template: ExpressionTemplate;
  readonly options: ReadonlySet<string>;
}

const REMEDIATION: Readonly<Record<ExplainBlockedReason, string>> = {
  "no-recipe": "Only a Landofile written by `lando init` from a recipe records provenance to explain.",
  "bare-provenance":
    "Re-run `lando init` with this recipe to record the producer identity and option values a comparison needs.",
  "invalid-provenance": "Correct the recipe identity, version, options, and service map in the Landofile.",
  "programmatic-landofile":
    "Provenance comparison never executes a programmatic Landofile. Inspect the recipe values in that file directly.",
  "includes-present":
    "Comparison never follows includes. Inline the included values, or read the included files yourself.",
  "unknown-recipe": "Install the plugin that publishes this recipe, or check the recorded recipe id.",
  "identity-mismatch":
    "The installed recipe is a different version than the one recorded. Run `lando app:config:migrate` to move the file forward.",
  "render-failed": "The recipe snapshot could not be rendered with the recorded option values.",
  "invalid-service-map":
    "Every `recipe.services` key must name a service the recipe generated, and no two keys may map to the same name.",
};

const blocked = (reason: ExplainBlockedReason, detail: string): ExplainComparison => ({
  status: "blocked",
  reason,
  detail,
  remediation: REMEDIATION[reason],
});

/** Dotted path in the grammar `getAtPath` reads: `services.web.env`, `tooling.test.cmds[0]`. */
const dotPath = (segments: ReadonlyArray<string | number>): string =>
  segments.reduce<string>(
    (accumulator, segment) =>
      typeof segment === "number"
        ? `${accumulator}[${segment}]`
        : accumulator === ""
          ? segment
          : `${accumulator}.${segment}`,
    "",
  );

const collectRecipeOptionNames = (node: ExpressionNode, into: Set<string>): void => {
  switch (node.kind) {
    case "Path": {
      const first = node.segments[0];
      if (node.head === "recipe" && first?.type === "prop") into.add(first.name);
      for (const segment of node.segments) {
        if (segment.type === "dynamic") collectRecipeOptionNames(segment.expr, into);
      }
      return;
    }
    case "Access": {
      collectRecipeOptionNames(node.target, into);
      for (const segment of node.segments) {
        if (segment.type === "dynamic") collectRecipeOptionNames(segment.expr, into);
      }
      return;
    }
    case "ArrayLiteral": {
      for (const element of node.elements) collectRecipeOptionNames(element, into);
      return;
    }
    case "ObjectLiteral": {
      for (const entry of node.entries) collectRecipeOptionNames(entry.value, into);
      return;
    }
    case "Call": {
      for (const argument of node.args) collectRecipeOptionNames(argument, into);
      return;
    }
    case "Conditional": {
      collectRecipeOptionNames(node.test, into);
      collectRecipeOptionNames(node.consequent, into);
      collectRecipeOptionNames(node.alternate, into);
      return;
    }
    default:
      return;
  }
};

const recipeOptionsInTemplate = (template: ExpressionTemplate): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const segment of template.segments) {
    if (segment.kind === "InterpolationSegment") collectRecipeOptionNames(segment.expression, names);
  }
  return names;
};

/**
 * Every value site in `value` whose expression reads a recipe option.
 *
 * The walk is deliberately syntactic: it parses but never evaluates, so a site
 * is reported exactly as the file authored it.
 */
const collectRecipeSites = (value: unknown, filePath: string): ReadonlyArray<RecipeSite> => {
  const sites: RecipeSite[] = [];
  const visit = (current: unknown, path: ReadonlyArray<string | number>): void => {
    if (typeof current === "string") {
      if (!current.includes("{{")) return;
      const parsed = parseExpressionEither(current, { filePath });
      if (Either.isLeft(parsed)) return;
      const options = recipeOptionsInTemplate(parsed.right);
      if (options.size === 0) return;
      sites.push({ path: dotPath(path), source: current, template: parsed.right, options });
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, [...path, index]));
      return;
    }
    if (typeof current === "object" && current !== null) {
      for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
        visit(entry, [...path, key]);
      }
    }
  };
  visit(value, []);
  return sites;
};

/** Rewrite a generated `services.<generated>` path prefix to its current name. */
const applyServiceMap = (path: string, serviceMap: ReadonlyMap<string, string>): string => {
  const prefix = "services.";
  if (serviceMap.size === 0 || !path.startsWith(prefix)) return path;
  const rest = path.slice(prefix.length);
  const dot = rest.indexOf(".");
  const bracket = rest.indexOf("[");
  const end = Math.min(dot === -1 ? rest.length : dot, bracket === -1 ? rest.length : bracket);
  const current = serviceMap.get(rest.slice(0, end));
  return current === undefined ? path : `${prefix}${current}${rest.slice(end)}`;
};

const renderCurrentValue = (value: unknown): string =>
  value === undefined ? "(absent)" : (JSON.stringify(value) ?? "null");

const readOptions = (
  provenance: LandofileRecipeProvenance | undefined,
): ReadonlyMap<string, RecipeOptionValue> => {
  const options = new Map<string, RecipeOptionValue>();
  if (provenance === undefined) return options;
  for (const [name, value] of Object.entries(provenance.options)) options.set(name, value);
  return options;
};

const readDefaults = (snapshot: RecipeSnapshot | undefined): ReadonlyMap<string, RecipeOptionValue> => {
  const defaults = new Map<string, RecipeOptionValue>();
  if (snapshot === undefined) return defaults;
  for (const [name, value] of Object.entries(snapshot.defaults)) defaults.set(name, value);
  return defaults;
};

const generatedServiceNames = (rendered: unknown): ReadonlySet<string> => {
  if (typeof rendered !== "object" || rendered === null) return new Set();
  const services = (rendered as { readonly services?: unknown }).services;
  if (typeof services !== "object" || services === null || Array.isArray(services)) return new Set();
  return new Set(Object.keys(services as Record<string, unknown>));
};

/** Independently readable identity and options when only the service map is unusable. */
const provenanceWithoutServiceMap = (raw: unknown): LandofileRecipeProvenance | undefined => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const rest = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "services"));
  const retried = validateLandofileRecipeProvenance(rest);
  if (Either.isLeft(retried) || isBareRecipeReference(retried.right)) return undefined;
  return retried.right;
};

const discoverExplainRoot = async (
  cwd: string,
): Promise<{ readonly appRoot: string; readonly dualForm: boolean }> => {
  try {
    const found = await findDiscoveredLandofilePath(cwd);
    return { appRoot: found.appRoot, dualForm: false };
  } catch (cause) {
    if (cause instanceof LandofileFormConflictError) {
      return { appRoot: dirname(cause.yamlPath), dualForm: true };
    }
    throw cause;
  }
};

interface SemanticComparison {
  readonly comparison: ExplainComparison;
  /** Generated sites keyed by option name, empty unless the comparison matched. */
  readonly takenOver: ReadonlyMap<string, ReadonlyArray<ExplainTakenOverSite>>;
  readonly services: ReadonlyArray<{ readonly generated: string; readonly current: string }>;
}

/**
 * Compare the current authoring document against the recipe's generated data.
 *
 * A generated site stays managed only while the current value parses to the
 * exact same expression tree. Equality of the resolved value proves nothing:
 * replacing `{{ recipe.php }}` with the same PHP version is still a takeover,
 * and keeping the option reference while changing a surrounding constant is too.
 */
const compareAgainstSnapshot = (
  provenance: LandofileRecipeProvenance,
  document: Record<string, unknown>,
  filePath: string,
): SemanticComparison => {
  const empty = new Map<string, ReadonlyArray<ExplainTakenOverSite>>();
  const snapshot = lookupRecipeSnapshot(provenance.id);
  if (snapshot === undefined) {
    return {
      comparison: blocked(
        "unknown-recipe",
        `No installed recipe publishes a snapshot for "${provenance.id}".`,
      ),
      takenOver: empty,
      services: [],
    };
  }
  if (!sameRecipeVersion(provenance.producer, snapshot.identity)) {
    return {
      comparison: blocked(
        "identity-mismatch",
        `The Landofile records ${provenance.producer.manifestVersion}, but the installed recipe publishes ${snapshot.identity.manifestVersion}.`,
      ),
      takenOver: empty,
      services: [],
    };
  }

  const rendered = renderRecipeSnapshot(snapshot, provenance.options);
  if (Either.isLeft(rendered)) {
    return {
      comparison: blocked("render-failed", rendered.left.message),
      takenOver: empty,
      services: [],
    };
  }

  const generated = generatedServiceNames(rendered.right);
  const mappings = Object.entries(provenance.services ?? {});
  const unknown = mappings.filter(([name]) => !generated.has(name)).map(([name]) => name);
  if (unknown.length > 0) {
    return {
      comparison: blocked(
        "invalid-service-map",
        `\`recipe.services\` names ${unknown.join(", ")}, which this recipe never generated.`,
      ),
      takenOver: empty,
      services: [],
    };
  }

  const serviceMap = new Map(mappings);
  const destinations = new Map<string, string>();
  for (const name of generated) {
    const current = serviceMap.get(name) ?? name;
    const previous = destinations.get(current);
    if (previous !== undefined) {
      return {
        comparison: blocked(
          "invalid-service-map",
          `\`recipe.services\` maps both ${previous} and ${name} onto "${current}".`,
        ),
        takenOver: empty,
        services: [],
      };
    }
    destinations.set(current, name);
  }

  const takenOver = new Map<string, ExplainTakenOverSite[]>();
  for (const site of collectRecipeSites(rendered.right, filePath)) {
    const path = applyServiceMap(site.path, serviceMap);
    const current = getAtPath(document, path);
    if (typeof current === "string") {
      const parsed = parseExpressionEither(current, { filePath });
      if (Either.isRight(parsed) && isDeepStrictEqual(parsed.right, site.template)) continue;
    }
    for (const option of site.options) {
      const entries = takenOver.get(option) ?? [];
      entries.push({
        path,
        generatedExpression: site.source,
        currentValue: renderCurrentValue(current),
      });
      takenOver.set(option, entries);
    }
  }
  for (const entries of takenOver.values())
    entries.sort((left, right) => left.path.localeCompare(right.path));

  return {
    comparison: { status: "matched", snapshotVersion: snapshot.identity.manifestVersion },
    takenOver,
    services: mappings.map(([generatedName, current]) => ({ generated: generatedName, current })),
  };
};

const readProvenance = (
  raw: unknown,
): {
  readonly form: AppConfigExplainResult["form"];
  readonly recipe: AppConfigExplainResult["recipe"];
  readonly provenance?: LandofileRecipeProvenance;
  readonly blockedComparison?: ExplainComparison;
} => {
  if (raw === undefined) {
    return {
      form: "absent",
      recipe: undefined,
      blockedComparison: blocked("no-recipe", "This Landofile records no `recipe:` provenance."),
    };
  }
  const validated = validateLandofileRecipeProvenance(raw);
  if (Either.isLeft(validated)) {
    const reason: ExplainBlockedReason =
      validated.left.reason === "service-map-not-injective" ? "invalid-service-map" : "invalid-provenance";
    const facts =
      validated.left.reason === "service-map-not-injective" ? provenanceWithoutServiceMap(raw) : undefined;
    return {
      form: "declarative",
      recipe:
        facts !== undefined
          ? { id: facts.id, version: facts.version, producer: facts.producer }
          : typeof raw === "object" && raw !== null && typeof (raw as { id?: unknown }).id === "string"
            ? { id: (raw as { readonly id: string }).id }
            : undefined,
      ...(facts === undefined ? {} : { provenance: facts }),
      blockedComparison: blocked(reason, validated.left.message),
    };
  }
  if (isBareRecipeReference(validated.right)) {
    return {
      form: "bare",
      recipe: { id: validated.right },
      blockedComparison: blocked(
        "bare-provenance",
        "This Landofile records a recipe id with no producer identity or option values.",
      ),
    };
  }
  const provenance = validated.right;
  return {
    form: "declarative",
    recipe: { id: provenance.id, version: provenance.version, producer: provenance.producer },
    provenance,
  };
};

/**
 * Read-only recipe provenance report.
 *
 * The canonical Landofile is parsed raw and alone: merging layers would resolve
 * `{{ recipe.<option> }}` into its value and destroy the very sites this report
 * exists to show, and following includes is forbidden outright. Nothing here
 * writes a file, builds a plan, contacts a provider, or executes app code.
 */
export const appConfigExplain = (
  options: AppConfigExplainOptions = {},
): Effect.Effect<AppConfigExplainResult, AppConfigExplainError, never> =>
  Effect.gen(function* () {
    const cwd = options.cwd ?? process.cwd();
    const discovered = yield* Effect.tryPromise({
      try: () => discoverExplainRoot(cwd),
      catch: (cause) =>
        cause instanceof LandofileNotFoundError
          ? cause
          : new LandofileNotFoundError({
              message: cause instanceof Error ? cause.message : `No Landofile found from ${cwd}.`,
              cwd,
            }),
    });
    const { appRoot, dualForm } = discovered;

    const programmaticPath = join(appRoot, PROGRAMMATIC_LANDOFILE);
    const landofilePath = join(appRoot, CANONICAL_LANDOFILE);
    const [programmaticFile, yamlExists] = yield* Effect.promise(() =>
      Promise.all([Bun.file(programmaticPath).exists(), Bun.file(landofilePath).exists()]),
    );
    const programmatic = dualForm || programmaticFile;
    if (programmatic && !yamlExists) {
      return {
        landofilePath: programmaticPath,
        form: "programmatic",
        comparison: blocked(
          "programmatic-landofile",
          "A programmatic Landofile is opaque to provenance comparison and is never executed for it.",
        ),
        services: [],
        options: [],
      } satisfies AppConfigExplainResult;
    }

    const content = yield* Effect.tryPromise({
      try: () => Bun.file(landofilePath).text(),
      catch: (cause) =>
        new LandofileParseError({
          message: cause instanceof Error ? cause.message : `Failed to read ${landofilePath}.`,
          filePath: landofilePath,
          line: undefined,
          column: undefined,
          cause,
        }),
    });
    const parsed = yield* parseLandofile({ file: landofilePath, content, cwd: appRoot });
    const document = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;

    const { recipe: recipeField, ...authoring } = document;
    const currentSites = collectRecipeSites(authoring, landofilePath);
    const read = readProvenance(recipeField);

    const includes = document.includes !== undefined;
    const skipSemantic = programmatic || includes || read.blockedComparison !== undefined;
    const semantic =
      skipSemantic || read.provenance === undefined
        ? undefined
        : compareAgainstSnapshot(read.provenance, document, landofilePath);

    const comparison: ExplainComparison = programmatic
      ? blocked(
          "programmatic-landofile",
          "A programmatic Landofile is opaque to provenance comparison and is never executed for it.",
        )
      : (read.blockedComparison ??
        (includes
          ? blocked(
              "includes-present",
              "This Landofile pulls in `includes:`, whose content is never followed for comparison.",
            )
          : (semantic?.comparison ??
            blocked("no-recipe", "This Landofile records no `recipe:` provenance."))));

    const matched = comparison.status === "matched";
    const recordedOptions = readOptions(read.provenance);
    const defaults = readDefaults(matched ? lookupRecipeSnapshot(read.provenance?.id ?? "") : undefined);
    const takenOver = semantic?.takenOver ?? new Map<string, ReadonlyArray<ExplainTakenOverSite>>();

    const referencesByOption = new Map<string, ExplainReference[]>();
    for (const site of currentSites) {
      for (const name of site.options) {
        const entries = referencesByOption.get(name) ?? [];
        entries.push({ path: site.path, expression: site.source });
        referencesByOption.set(name, entries);
      }
    }

    const names = [...new Set([...recordedOptions.keys(), ...referencesByOption.keys()])].sort();
    const reported = names.map((name) => {
      const value = recordedOptions.get(name);
      const fallback = defaults.get(name);
      const declaredDefault = matched && fallback !== undefined ? fallback : undefined;
      const references = (referencesByOption.get(name) ?? []).toSorted((left, right) =>
        left.path.localeCompare(right.path),
      );
      return {
        name,
        ...(value === undefined ? {} : { value }),
        ...(declaredDefault === undefined ? {} : { default: declaredDefault }),
        ...(matched && value !== undefined
          ? {
              status: isDeepStrictEqual(value, declaredDefault)
                ? ("accepted-by-value" as const)
                : ("chosen-by-value" as const),
            }
          : {}),
        references,
        takenOver: takenOver.get(name) ?? [],
      };
    });

    return {
      landofilePath,
      form: read.form,
      ...(read.recipe === undefined ? {} : { recipe: read.recipe }),
      comparison,
      services: semantic?.services ?? [],
      options: reported,
    } satisfies AppConfigExplainResult;
  });
