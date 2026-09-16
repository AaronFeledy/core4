import { dirname } from "node:path";

import { LandofileFormConflictError } from "@lando/sdk/errors";
import { type ExpressionNode, type ExpressionTemplate, parseExpressionEither } from "@lando/sdk/expressions";
import { isBareRecipeReference, validateLandofileRecipeProvenance } from "@lando/sdk/recipes";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import { Either } from "effect";

import { findDiscoveredLandofilePath } from "@lando/engine/services/landofile-live";

export const CANONICAL_LANDOFILE = ".lando.yml";
export const PROGRAMMATIC_LANDOFILE = ".lando.ts";

export interface RecipeSite {
  readonly path: string;
  readonly source: string;
  readonly template: ExpressionTemplate;
  readonly options: ReadonlySet<string>;
}

/** Dotted path in the grammar `getAtPath` reads: `services.web.env`, `tooling.test.cmds[0]`. */
export const dotPath = (segments: ReadonlyArray<string | number>): string =>
  segments.reduce<string>(
    (accumulator, segment) =>
      typeof segment === "number"
        ? `${accumulator}[${segment}]`
        : accumulator === ""
          ? segment
          : `${accumulator}.${segment}`,
    "",
  );

export const collectRecipeOptionNames = (node: ExpressionNode, into: Set<string>): void => {
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

export const recipeOptionsInTemplate = (template: ExpressionTemplate): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const segment of template.segments) {
    if (segment.kind === "InterpolationSegment") collectRecipeOptionNames(segment.expression, names);
  }
  return names;
};

/**
 * The walk is deliberately syntactic: it parses but never evaluates, so a site
 * is reported exactly as the file authored it.
 */
export const collectRecipeSites = (value: unknown, filePath: string): ReadonlyArray<RecipeSite> => {
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

export const applyServiceMap = (path: string, serviceMap: ReadonlyMap<string, string>): string => {
  const prefix = "services.";
  if (serviceMap.size === 0 || !path.startsWith(prefix)) return path;
  const rest = path.slice(prefix.length);
  const dot = rest.indexOf(".");
  const bracket = rest.indexOf("[");
  const end = Math.min(dot === -1 ? rest.length : dot, bracket === -1 ? rest.length : bracket);
  const current = serviceMap.get(rest.slice(0, end));
  return current === undefined ? path : `${prefix}${current}${rest.slice(end)}`;
};

export const renderCurrentValue = (value: unknown): string =>
  value === undefined ? "(absent)" : (JSON.stringify(value) ?? "null");

export const generatedServiceNames = (rendered: unknown): ReadonlySet<string> => {
  if (typeof rendered !== "object" || rendered === null) return new Set();
  const services = (rendered as { readonly services?: unknown }).services;
  if (typeof services !== "object" || services === null || Array.isArray(services)) return new Set();
  return new Set(Object.keys(services as Record<string, unknown>));
};

/** Independently readable identity and options when only the service map is unusable. */
export const provenanceWithoutServiceMap = (raw: unknown): LandofileRecipeProvenance | undefined => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const rest = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "services"));
  const retried = validateLandofileRecipeProvenance(rest);
  if (Either.isLeft(retried) || isBareRecipeReference(retried.right)) return undefined;
  return retried.right;
};

export const discoverRecipeAnalysisRoot = async (
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
