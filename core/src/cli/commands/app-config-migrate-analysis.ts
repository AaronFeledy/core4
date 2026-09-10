import { isDeepStrictEqual } from "node:util";
import { getAtPath, setAtPath, unsetAtPath } from "@lando/engine/config-write/dot-path";
import {
  classifyHunk,
  renderRecipeSnapshot,
  selectMigrationPath,
  validateMigrationChain,
} from "@lando/sdk/recipes";
import type {
  LandofileRecipeProvenance,
  RecipeMigration,
  RecipeMigrationHunk,
  RecipeProducer,
  RecipeSnapshot,
} from "@lando/sdk/schema";
import { Either } from "effect";
import type { MigrateHunkBlockReason, MigrateHunkResult } from "./app-config-migrate-output.ts";
import { matchesGenerated, renameMigrationService } from "./app-config-migrate-rename.ts";
import { applyServiceMap, collectRecipeSites } from "./app-config-recipe-analysis.ts";

export type RecipeMigrationAnalysisInput = {
  readonly document: Record<string, unknown>;
  readonly provenance: LandofileRecipeProvenance;
  readonly target: RecipeSnapshot;
  readonly migrations: ReadonlyArray<RecipeMigration>;
  readonly decide: (hunk: RecipeMigrationHunk) => boolean;
};
export type RecipeMigrationEdgeAnalysis = {
  readonly from: RecipeProducer;
  readonly to: RecipeProducer;
  readonly status: "satisfied" | "blocking";
  readonly hunks: ReadonlyArray<MigrateHunkResult>;
};
export type RecipeMigrationAnalysis = {
  readonly status: "satisfied" | "blocking" | "no-mutation";
  readonly edges: ReadonlyArray<RecipeMigrationEdgeAnalysis>;
  readonly document: Record<string, unknown>;
  readonly committed?: RecipeProducer;
  readonly noMutation?: "already-current" | "missing-old-snapshot" | "identity-mismatch";
};

const block = (hunk: MigrateHunkResult, reason: MigrateHunkBlockReason): MigrateHunkResult => ({
  ...hunk,
  classification: "blocking",
  reason,
});

/** Analyze without IO, retaining only the longest fully satisfied edge prefix. */
export const analyzeRecipeMigration = (input: RecipeMigrationAnalysisInput): RecipeMigrationAnalysis => {
  const original = structuredClone(input.document);
  const chain = validateMigrationChain(input.target.identity, input.migrations);
  if (Either.isLeft(chain)) return { status: "blocking", document: original, edges: [] };
  const selection = selectMigrationPath(chain.right, input.provenance.producer, input.target.identity);
  switch (selection.kind) {
    case "no-mutation":
      return { status: "no-mutation", document: original, edges: [], noMutation: selection.reason };
    case "path":
      break;
    default:
      return selection satisfies never;
  }
  let document: unknown = original;
  let options = { ...input.provenance.options };
  let serviceMap = new Map(Object.entries(input.provenance.services ?? {}));
  let committed: RecipeProducer | undefined;
  let blocked = false;
  const edges: RecipeMigrationEdgeAnalysis[] = [];
  for (const edge of selection.migrations) {
    let candidate = structuredClone(document);
    const candidateOptions = { ...options };
    const hunks: MigrateHunkResult[] = [];
    const renderedOld = blocked ? undefined : renderRecipeSnapshot(edge.fromSnapshot, options);
    const sites =
      renderedOld !== undefined && Either.isRight(renderedOld)
        ? new Map(collectRecipeSites(renderedOld.right, ".lando.yml").map((site) => [site.path, site]))
        : new Map();
    for (const hunk of edge.hunks) {
      const mappedPath = applyServiceMap(hunk.path, serviceMap);
      let analyzed: MigrateHunkResult = {
        id: hunk.id,
        kind: hunk.kind,
        layer: hunk.layer,
        path: hunk.path,
        mappedPath,
        classification: "blocking",
      };
      if (blocked) {
        hunks.push(analyzed);
        continue;
      }
      if (renderedOld === undefined || Either.isLeft(renderedOld)) {
        hunks.push(block(analyzed, "render-failed"));
        continue;
      }
      if (hunk.layer !== "canonical") {
        hunks.push(block(analyzed, "layer-not-owned"));
        continue;
      }
      const raw = getAtPath(candidate, mappedPath);
      const generated = getAtPath(renderedOld.right, hunk.path);
      // Snapshot output is authoring data. Normalize intact expression trees to
      // that output before classification, never to an evaluated option literal.
      const managed = matchesGenerated(raw, generated);
      const current = managed && sites.has(hunk.path) ? generated : raw;
      switch (hunk.kind) {
        case "rename": {
          const oldValue = getAtPath(candidate, applyServiceMap(hunk.old, serviceMap));
          const newValue = getAtPath(candidate, applyServiceMap(hunk.new, serviceMap));
          if (oldValue === undefined && newValue !== undefined)
            analyzed = { ...analyzed, classification: "already-satisfied" };
          else if (newValue !== undefined) analyzed = block(analyzed, "rename-target-collision");
          else if (oldValue === undefined) analyzed = block(analyzed, "rename-source-missing");
          else if (!managed) analyzed = block(analyzed, "site-taken-over");
          else analyzed = { ...analyzed, classification: "selected" };
          break;
        }
        case "option-default":
        case "add":
        case "remove":
        case "replace":
          analyzed = { ...analyzed, classification: classifyHunk(hunk, { current }) };
          if (analyzed.classification === "blocking")
            analyzed = block(analyzed, raw !== undefined && !managed ? "site-taken-over" : "value-conflict");
          break;
        default:
          hunk satisfies never;
      }
      if (analyzed.classification === "selected" && !input.decide(hunk)) {
        analyzed =
          hunk.kind === "option-default"
            ? { ...analyzed, classification: "retained-option" }
            : block(analyzed, "declined");
      }
      if (hunk.kind === "option-default" && analyzed.classification === "selected") {
        candidateOptions[hunk.path.slice("recipe.options.".length)] = hunk.new;
        candidate = setAtPath(candidate, hunk.path, hunk.new);
      }
      hunks.push(analyzed);
    }
    if (!blocked && renderedOld !== undefined && Either.isRight(renderedOld)) {
      const renderedNew = renderRecipeSnapshot(edge.toSnapshot, candidateOptions);
      if (Either.isLeft(renderedNew)) {
        for (const [index, hunk] of hunks.entries()) hunks[index] = block(hunk, "render-failed");
      } else {
        for (const [index, hunk] of edge.hunks.entries()) {
          const analyzed = hunks[index];
          if (analyzed === undefined || analyzed.classification === "blocking") continue;
          switch (hunk.kind) {
            case "add":
            case "replace": {
              const next = getAtPath(renderedNew.right, hunk.path);
              if (!isDeepStrictEqual(next, hunk.new))
                hunks[index] = block(analyzed, "hunk-snapshot-mismatch");
              else if (analyzed.classification === "selected")
                candidate = setAtPath(candidate, analyzed.mappedPath, next);
              break;
            }
            case "remove":
              if (getAtPath(renderedNew.right, hunk.path) !== undefined)
                hunks[index] = block(analyzed, "hunk-snapshot-mismatch");
              else if (analyzed.classification === "selected")
                candidate = unsetAtPath(candidate, analyzed.mappedPath).next;
              break;
            case "rename":
              if (analyzed.classification === "already-satisfied") {
                const expected = getAtPath(renderedNew.right, hunk.new);
                const actual = getAtPath(candidate, applyServiceMap(hunk.new, serviceMap));
                if (!matchesGenerated(actual, expected) && !isDeepStrictEqual(actual, expected))
                  hunks[index] = block(analyzed, "rename-target-collision");
              } else if (analyzed.classification === "selected") {
                const renamed = renameMigrationService(hunk, {
                  document: candidate,
                  renderedOld: renderedOld.right,
                  renderedNew: renderedNew.right,
                  serviceMap,
                });
                switch (renamed.kind) {
                  case "applied":
                    candidate = renamed.document;
                    break;
                  case "blocking":
                    hunks[index] = block(analyzed, "site-taken-over");
                    break;
                  default:
                    renamed satisfies never;
                }
              }
              break;
            case "option-default": {
              const name = hunk.path.slice("recipe.options.".length);
              if (!isDeepStrictEqual(hunk.new, edge.toSnapshot.defaults[name]))
                hunks[index] = block(analyzed, "hunk-snapshot-mismatch");
              break;
            }
            default:
              hunk satisfies never;
          }
        }
      }
    }
    blocked ||= hunks.some((hunk) => hunk.classification === "blocking");
    edges.push({ from: edge.from, to: edge.to, status: blocked ? "blocking" : "satisfied", hunks });
    if (!blocked) {
      document = candidate;
      options = candidateOptions;
      committed = edge.to;
      const mappings = getAtPath(document, "recipe.services");
      if (mappings !== null && typeof mappings === "object") {
        serviceMap = new Map(
          Object.entries(mappings).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        );
      }
    }
  }
  if (committed !== undefined) {
    document = setAtPath(document, "recipe.version", committed.manifestVersion);
    document = setAtPath(document, "recipe.producer", committed);
  }
  // Dot-path writes preserve the record root for these canonical paths.
  if (document === null || typeof document !== "object" || Array.isArray(document))
    return { status: "blocking", document: original, edges };
  return {
    status: blocked ? "blocking" : "satisfied",
    edges,
    document: Object.fromEntries(Object.entries(document)),
    ...(committed === undefined ? {} : { committed }),
  };
};
