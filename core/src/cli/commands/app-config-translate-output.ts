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

export const AppConfigTranslateResultSchema = Schema.Union(
  ListResultSchema,
  DetectResultSchema,
  PreviewResultSchema,
  WriteResultSchema,
);

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

const diagnosticComment = (diagnostic: ConfigTranslateDiagnostic): string =>
  `# ${DIAGNOSTIC_GLYPH[diagnostic.kind]} ${diagnostic.message} (${diagnostic.sourceId}:${diagnostic.keyPath.join(".")})`;

const renderAnnotated = (
  header: string,
  diagnostics: ReadonlyArray<ConfigTranslateDiagnostic>,
  deletions: ReadonlyArray<ConfigTranslateDeletion>,
): string =>
  [
    header,
    ...diagnostics.map(diagnosticComment),
    ...(deletions.length > 0 ? [`# deletions: ${deletions.map((item) => item.sourceId).join(", ")}`] : []),
  ].join("\n");

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
        ...result.written.map((path) => `${path}: wrote ${result.target} Landofile layer.`),
        ...result.removed.map((path) => `${path}: removed translated source.`),
        ...result.backups.map((path) => `# backup: ${path}`),
      ].join("\n");
      return renderAnnotated(header, result.diagnostics, result.deletions);
    }
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
};
