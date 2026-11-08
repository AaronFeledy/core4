import {
  ConfigTranslateDeletion,
  ConfigTranslateDiagnostic,
  ConfigTranslateMatch,
  LandofileLayer,
} from "@lando/sdk/schema";
import { Schema } from "effect";

export type AppConfigTranslateFormat = "yaml" | "table" | "json";

const TranslatorInfoSchema = Schema.Struct({
  id: Schema.String,
  summary: Schema.String,
  inputKinds: Schema.Array(Schema.String),
});

const ListResultSchema = Schema.Struct({
  mode: Schema.Literal("list"),
  translators: Schema.Array(TranslatorInfoSchema),
});

const DetectResultSchema = Schema.Struct({
  mode: Schema.Literal("detect"),
  inputPath: Schema.String,
  files: Schema.Array(Schema.String),
  matches: Schema.Array(ConfigTranslateMatch),
});

const TranslateTargetSchema = Schema.Struct({
  layer: LandofileLayer,
  path: Schema.String,
  content: Schema.String,
});

const PreviewResultSchema = Schema.Struct({
  mode: Schema.Literal("preview"),
  inputPath: Schema.String,
  translator: Schema.String,
  target: Schema.String,
  files: Schema.Array(Schema.String),
  content: Schema.String,
  targets: Schema.Array(TranslateTargetSchema),
  diagnostics: Schema.Array(ConfigTranslateDiagnostic),
  deletions: Schema.Array(ConfigTranslateDeletion),
});

const WriteResultSchema = Schema.Struct({
  mode: Schema.Literal("write"),
  inputPath: Schema.String,
  target: Schema.String,
  written: Schema.Array(Schema.String),
  backups: Schema.Array(Schema.String),
  removed: Schema.Array(Schema.String),
  diagnostics: Schema.Array(ConfigTranslateDiagnostic),
  deletions: Schema.Array(ConfigTranslateDeletion),
});

export const AppConfigTranslateResultSchema = Schema.Union([
  ListResultSchema,
  DetectResultSchema,
  PreviewResultSchema,
  WriteResultSchema,
]);

export type AppConfigTranslateResult = Schema.Schema.Type<typeof AppConfigTranslateResultSchema>;
type AppConfigTranslateTarget = Schema.Schema.Type<typeof TranslateTargetSchema>;

const DIAGNOSTIC_GLYPH = {
  generated: "+",
  dropped: "-",
  rewritten: "~",
  unsupported: "!",
  "non-portable": "~",
  "needs-review": "?",
} as const;

const DIAGNOSTIC_ORDER = [
  "unsupported",
  "non-portable",
  "needs-review",
  "dropped",
  "rewritten",
  "generated",
] as const;

// Comment every physical line, including multiline plugin messages and paths.
const comment = (text: string): string =>
  text
    .split(/\r\n|[\n\r\u2028\u2029]/u)
    .map((line) => `# ${line}`)
    .join("\n");

export const renderTranslateDiagnostics = (diagnostics: ReadonlyArray<ConfigTranslateDiagnostic>): string => {
  if (diagnostics.length === 0) return "";
  const groups = new Map<
    string,
    { readonly diagnostic: ConfigTranslateDiagnostic; readonly leaves: Array<string | number> }
  >();
  for (const diagnostic of diagnostics) {
    const parent = diagnostic.keyPath.length === 0 ? null : diagnostic.keyPath.slice(0, -1);
    const key = JSON.stringify([
      diagnostic.kind,
      diagnostic.sourceId,
      parent,
      diagnostic.message,
      diagnostic.remediation,
    ]);
    const leaf = diagnostic.keyPath.at(-1);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { diagnostic, leaves: leaf === undefined ? [] : [leaf] });
    else if (leaf !== undefined) group.leaves.push(leaf);
  }
  const summary = DIAGNOSTIC_ORDER.flatMap((kind) => {
    const count = diagnostics.filter((diagnostic) => diagnostic.kind === kind).length;
    if (count === 0) return [];
    const blocking = kind === "unsupported" || kind === "non-portable";
    return [`${count} ${kind}${blocking ? " (blocks --write)" : ""}`];
  }).join(", ");
  const grouped = [...groups.values()];
  return [
    comment(summary),
    ...DIAGNOSTIC_ORDER.flatMap((kind) =>
      grouped
        .filter(({ diagnostic }) => diagnostic.kind === kind)
        .map(({ diagnostic, leaves }) => {
          const path =
            leaves.length > 1
              ? [...diagnostic.keyPath.slice(0, -1), `{${leaves.join(", ")}}`].join(".")
              : diagnostic.keyPath.join(".");
          const remediation =
            kind === "generated" || kind === "rewritten" ? undefined : diagnostic.remediation;
          return comment(
            `${DIAGNOSTIC_GLYPH[kind]} [${kind}] ${diagnostic.message} (${diagnostic.sourceId}:${path})${remediation === undefined ? "" : `\n  Next: ${remediation}`}`,
          );
        }),
    ),
  ].join("\n");
};

const renderAnnotated = (
  header: string,
  diagnostics: ReadonlyArray<ConfigTranslateDiagnostic>,
  deletions: ReadonlyArray<ConfigTranslateDeletion>,
): string =>
  [
    header,
    renderTranslateDiagnostics(diagnostics),
    ...(deletions.length > 0
      ? [comment(`deletions: ${deletions.map((item) => item.sourceId).join(", ")}`)]
      : []),
  ]
    .filter(Boolean)
    .join("\n");

/**
 * A single target reads as the bare Landofile; several targets are labeled with
 * the declared path each block belongs to, because writing one layer never
 * flattens the others into one document.
 */
export const renderTranslateTargets = (targets: ReadonlyArray<AppConfigTranslateTarget>): string => {
  const first = targets[0];
  if (targets.length === 0) return "";
  if (targets.length === 1 && first !== undefined) return first.content;
  return targets.map((target) => `# ${target.path}\n${target.content.replace(/\n$/u, "")}`).join("\n\n");
};

export const renderConfigTranslateResult = (
  result: AppConfigTranslateResult,
  _format: AppConfigTranslateFormat = "yaml",
): string => {
  switch (result.mode) {
    case "list":
      return result.translators.length === 0
        ? "No config translators are installed."
        : result.translators
            .map(
              (translator) => `${translator.id}\t${translator.inputKinds.join(", ")}\t${translator.summary}`,
            )
            .join("\n");
    case "detect":
      return result.matches.length === 0
        ? "No config translator matches detected."
        : result.matches
            .map((match) => `${match.translator}\t${match.confidence}\t${match.sourceIds.join(", ")}`)
            .join("\n");
    case "preview":
      return result.diagnostics.length === 0 && result.deletions.length === 0
        ? result.content
        : renderAnnotated(result.content.replace(/\n$/u, ""), result.diagnostics, result.deletions);
    case "write": {
      const header = [
        ...result.written.map((path) => comment(`${path}: wrote ${result.target} Landofile layer.`)),
        ...result.removed.map((path) => comment(`${path}: removed translated source.`)),
      ].join("\n");
      return [
        renderAnnotated(header, result.diagnostics, result.deletions),
        comment(
          `Receipt: ${result.written.length} written, ${result.removed.length} removed, ${result.backups.length} backup${result.backups.length === 1 ? "" : "s"}`,
        ),
        ...result.backups.map((path) => comment(`backup: ${path}`)),
        comment(
          `Review: ${result.diagnostics.filter((item) => item.kind === "needs-review").length} needs-review, ${result.diagnostics.filter((item) => item.kind === "dropped").length} dropped`,
        ),
        comment("Next: lando app:config:lint"),
      ]
        .filter(Boolean)
        .join("\n");
    }
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
};
