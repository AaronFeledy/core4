import { LandofileLayer, RecipeHunkClassification, RecipeHunkKind, RecipeProducer } from "@lando/sdk/schema";
import { Schema } from "effect";

/**
 * Why migrate refuses to touch the Landofile before any edge runs.
 *
 * These are opaque or unreadable inputs: the chain never starts, so nothing is
 * committed. Distinct from a hunk that blocks mid-chain after a satisfied prefix.
 */
export const MigrateBlockedReason = Schema.Literal(
  "programmatic-landofile",
  "includes-present",
  "bare-provenance",
  "invalid-provenance",
  "unknown-recipe",
  "invalid-service-map",
);
export type MigrateBlockedReason = typeof MigrateBlockedReason.Type;

/**
 * Why one migration hunk refused to apply against the current file.
 *
 * Carried only when classification is `blocking` so machine consumers can branch
 * without scraping remediation prose.
 */
export const MigrateHunkBlockReason = Schema.Literal(
  "site-taken-over",
  "value-conflict",
  "layer-not-owned",
  "render-failed",
  "hunk-snapshot-mismatch",
  "rename-target-collision",
  "rename-source-missing",
  "declined",
);
export type MigrateHunkBlockReason = typeof MigrateHunkBlockReason.Type;

/** One classified hunk inside a migration edge, ready for machine output. */
export const MigrateHunkResult = Schema.Struct({
  id: Schema.String,
  kind: RecipeHunkKind,
  layer: LandofileLayer,
  path: Schema.String,
  mappedPath: Schema.String,
  classification: RecipeHunkClassification,
  reason: Schema.optional(MigrateHunkBlockReason),
  remediation: Schema.optional(Schema.String),
});
export type MigrateHunkResult = typeof MigrateHunkResult.Type;

/**
 * One edge in the ordered chain with every hunk already classified.
 *
 * `from`/`to` are stable versioned producer keys; status is the edge verdict
 * after classification (`skipped` means a later edge after a block).
 */
export const MigrateEdgeResult = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  status: Schema.Literal("satisfied", "blocked", "skipped"),
  hunks: Schema.Array(MigrateHunkResult),
});
export type MigrateEdgeResult = typeof MigrateEdgeResult.Type;

export const AppConfigMigrateResultSchema = Schema.Struct({
  mode: Schema.Literal("write", "dry-run"),
  status: Schema.Literal("committed", "partial", "blocked", "no-op"),
  landofilePath: Schema.String,
  target: RecipeProducer,
  recorded: Schema.optional(RecipeProducer),
  committed: Schema.optional(RecipeProducer),
  noMutation: Schema.optional(Schema.Literal("missing-old-snapshot", "already-current")),
  blocked: Schema.optional(
    Schema.Struct({
      reason: MigrateBlockedReason,
      detail: Schema.String,
      remediation: Schema.String,
    }),
  ),
  edges: Schema.Array(MigrateEdgeResult),
  next: Schema.String,
});

export type AppConfigMigrateResult = typeof AppConfigMigrateResultSchema.Type;

const REBUILD_LINE = "run `lando rebuild`";

const formatProducer = (label: string, producer: RecipeProducer): readonly string[] => [
  `${label}: ${producer.recipeId} ${producer.manifestVersion}`,
  `Producer: ${producer.sourceKind} ${producer.packageName}`,
  `Digest: ${producer.contentDigest}`,
];

const formatHunkLine = (
  edge: { readonly from: string; readonly to: string },
  hunk: MigrateHunkResult,
): string => {
  const base = `${edge.from} -> ${edge.to}: ${hunk.kind} ${hunk.path} [${hunk.classification}]`;
  if (hunk.classification !== "blocking" || hunk.reason === undefined) return base;
  return `${base} (${hunk.reason})`;
};

/**
 * Human report for the active renderer.
 *
 * Dry-run still prints the complete ordered hunk set so the reader can audit
 * every edit before writing. Committed and partial runs always end with the
 * rebuild instruction so the next step is unambiguous.
 */
export const renderAppConfigMigrateResult = (result: AppConfigMigrateResult): string => {
  const lines: string[] = [`Landofile: ${result.landofilePath}`, ...formatProducer("Target", result.target)];

  if (result.recorded !== undefined) {
    lines.push(...formatProducer("Recorded", result.recorded));
  }
  if (result.committed !== undefined) {
    lines.push(...formatProducer("Committed", result.committed));
  }

  lines.push(`Status: ${result.status}`);
  if (result.mode === "dry-run") lines.push("Dry-run: nothing was written.");

  if (result.status === "no-op") {
    const why =
      result.noMutation === "missing-old-snapshot"
        ? "no old snapshot to migrate from"
        : result.noMutation === "already-current"
          ? "already current"
          : "nothing to do";
    lines.push(`Nothing changed: ${why}.`);
  }

  if (result.blocked !== undefined) {
    lines.push(`Blocked (${result.blocked.reason}): ${result.blocked.detail}`);
    lines.push(`  ${result.blocked.remediation}`);
  }

  for (const edge of result.edges) {
    lines.push(`Edge: ${edge.from} -> ${edge.to} (${edge.status})`);
    for (const hunk of edge.hunks) {
      lines.push(`  ${formatHunkLine(edge, hunk)}`);
      if (hunk.classification === "blocking" && hunk.remediation !== undefined) {
        lines.push(`    ${hunk.remediation}`);
      }
    }
  }

  if (result.next.length > 0 && result.next !== REBUILD_LINE) lines.push(result.next);
  if (result.status === "committed" || result.status === "partial") lines.push(REBUILD_LINE);

  return lines.join("\n");
};
