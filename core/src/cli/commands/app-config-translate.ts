import { readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { Effect, Schema } from "effect";

import type { ConfigTranslatorConflictError } from "@lando/sdk/errors";
import {
  ConfigTranslateError,
  ConfigTranslateNoTranslatorsError,
  LandofileNotFoundError,
  LandofileParseError,
  type NotImplementedError,
} from "@lando/sdk/errors";
import { emitLandofileYaml } from "@lando/sdk/landofile";
import type { AbsolutePath, PortablePath } from "@lando/sdk/schema";
import { LandofileShape } from "@lando/sdk/schema";
import type { ConfigTranslateMatch, ConfigTranslatorShape } from "@lando/sdk/services";

import { writeFileAtomicViaRename } from "../../cache/atomic.ts";
import {
  detectConfigTranslators,
  resolveConfigTranslators,
  runConfigTranslators,
} from "../../landofile/config-translate.ts";
import { findLandofilePath } from "../../landofile/discovery.ts";
import { mergeLandofiles } from "../../landofile/merge.ts";
import { parseLandofile } from "../../landofile/parser.ts";
import { rejectBetaToolingFeatures } from "../../landofile/tooling-beta.ts";

export type AppConfigTranslateFormat = "yaml" | "table" | "json";

export interface AppConfigTranslateOptions {
  readonly cwd?: string;
  readonly write?: boolean;
  readonly list?: boolean;
  readonly detect?: boolean;
  readonly from?: string;
  readonly files?: ReadonlyArray<string>;
  readonly translators?: ReadonlyArray<ConfigTranslatorShape>;
}

const ConfigTranslateDiagnosticSchema = Schema.Struct({
  kind: Schema.Union(
    Schema.Literal("generated"),
    Schema.Literal("unsupported"),
    Schema.Literal("non-portable"),
    Schema.Literal("needs-review"),
  ),
  message: Schema.String,
  path: Schema.optional(Schema.String),
});

const TranslatorInfoSchema = Schema.Struct({
  id: Schema.String,
  summary: Schema.String,
  inputKinds: Schema.Array(Schema.String),
});

const ListResultSchema = Schema.Struct({
  mode: Schema.Literal("list"),
  translators: Schema.Array(TranslatorInfoSchema),
});

const ConfigTranslateMatchSchema = Schema.Struct({
  translator: Schema.String,
  files: Schema.Array(Schema.String),
  confidence: Schema.Union(Schema.Literal("exact"), Schema.Literal("likely"), Schema.Literal("possible")),
  summary: Schema.optional(Schema.String),
});

const DetectResultSchema = Schema.Struct({
  mode: Schema.Literal("detect"),
  inputPath: Schema.String,
  files: Schema.Array(Schema.String),
  matches: Schema.Array(ConfigTranslateMatchSchema),
});

const PreviewResultSchema = Schema.Struct({
  mode: Schema.Literal("preview"),
  inputPath: Schema.String,
  translator: Schema.String,
  files: Schema.Array(Schema.String),
  content: Schema.String,
  diagnostics: Schema.Array(ConfigTranslateDiagnosticSchema),
});

const WriteResultSchema = Schema.Struct({
  mode: Schema.Literal("write"),
  inputPath: Schema.String,
  outputPath: Schema.String,
  backupPath: Schema.optional(Schema.String),
  diagnostics: Schema.Array(ConfigTranslateDiagnosticSchema),
});

export const AppConfigTranslateResultSchema = Schema.Union(
  ListResultSchema,
  DetectResultSchema,
  PreviewResultSchema,
  WriteResultSchema,
);

export type AppConfigTranslateResult = Schema.Schema.Type<typeof AppConfigTranslateResultSchema>;

type TranslateDiagnostic = Schema.Schema.Type<typeof ConfigTranslateDiagnosticSchema>;
type ConfigTranslateRenderedMatch = Schema.Schema.Type<typeof ConfigTranslateMatchSchema>;
type TranslatorInfo = Schema.Schema.Type<typeof TranslatorInfoSchema>;
type WriteResult = Schema.Schema.Type<typeof WriteResultSchema>;

export type AppConfigTranslateError =
  | LandofileNotFoundError
  | LandofileParseError
  | NotImplementedError
  | ConfigTranslateNoTranslatorsError
  | ConfigTranslateError
  | ConfigTranslatorConflictError;

const decodeLandofile = Schema.decodeUnknownEither(LandofileShape);

const writeFile = (path: string, content: string): Effect.Effect<void, ConfigTranslateError> =>
  Effect.tryPromise({
    try: () => writeFileAtomicViaRename(path, content),
    catch: (cause) =>
      new ConfigTranslateError({
        message: `Could not write ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });

const fromRemediation = (translators: ReadonlyArray<ConfigTranslatorShape>): string => {
  const choices = translators.map((translator) => `--from ${translator.id}`).join(", ");
  return `Choose an explicit translator with one of: ${choices}.`;
};

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u;

const sourceFilePathError = (file: string): ConfigTranslateError =>
  new ConfigTranslateError({
    message: `Config translator source file "${file}" must be a relative path inside the app root.`,
    remediation:
      "Pass a source file relative to the app root. Reading outside the app root requires an explicit outside-root opt-in before it can be supported.",
  });

const parseSourceFilePath = (file: string): Effect.Effect<PortablePath, ConfigTranslateError> => {
  const portable = file.replace(/\\/gu, "/");
  const segments = portable.split("/");
  if (
    portable.length === 0 ||
    portable.startsWith("/") ||
    file.startsWith("\\") ||
    WINDOWS_ABSOLUTE_PATH.test(file) ||
    segments.some((segment) => segment === "..")
  ) {
    return Effect.fail(sourceFilePathError(file));
  }
  return Effect.succeed(portable as PortablePath);
};

const discoverSourceFiles = (
  appRoot: string,
): Effect.Effect<ReadonlyArray<PortablePath>, ConfigTranslateError> =>
  Effect.tryPromise({
    try: async () => {
      const files: Array<PortablePath> = [];
      const visit = async (dir: string): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const absolute = join(dir, entry.name);
          if (entry.isDirectory()) {
            await visit(absolute);
            continue;
          }
          if (entry.isFile()) files.push(relative(appRoot, absolute).replace(/\\/gu, "/") as PortablePath);
        }
      };
      await visit(appRoot);
      return files.sort();
    },
    catch: (cause) =>
      new ConfigTranslateError({
        message: `Could not discover config translator source files: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });

const distinctMatchIds = (matches: ReadonlyArray<ConfigTranslateMatch>): ReadonlyArray<string> => {
  const seen: Array<string> = [];
  for (const match of matches) if (!seen.includes(match.translator)) seen.push(match.translator);
  return seen;
};

/**
 * Select the single translator to run. `--from` forces a translator by id;
 * otherwise the registered translators' `detect` surfaces are probed and the
 * lone `exact`/`likely` match wins. Zero or multiple matches fail with a
 * remediation enumerating the `--from` choices when detection is ambiguous.
 */
const selectTranslator = (
  translators: ReadonlyArray<ConfigTranslatorShape>,
  from: string | undefined,
  appRoot: AbsolutePath,
  files: ReadonlyArray<PortablePath>,
): Effect.Effect<ConfigTranslatorShape, ConfigTranslateError | ConfigTranslatorConflictError> =>
  Effect.gen(function* () {
    if (from !== undefined) {
      const forced = translators.find((translator) => translator.id === from);
      if (forced === undefined) {
        return yield* Effect.fail(
          new ConfigTranslateError({
            message: `No config translator with id "${from}" is registered.`,
            remediation: fromRemediation(translators),
          }),
        );
      }
      return forced;
    }

    const matches = yield* detectConfigTranslators(translators, { appRoot, files });
    const confident = matches.filter(
      (match) => match.confidence === "exact" || match.confidence === "likely",
    );
    const ids = distinctMatchIds(confident);
    if (ids.length === 0) {
      return yield* Effect.fail(
        new ConfigTranslateError({
          message: "No config translator detected a supported source file under the app root.",
          remediation: `${fromRemediation(translators)} Scope the input files with --file <path> when a translator cannot autodetect.`,
        }),
      );
    }
    if (ids.length > 1) {
      const matched = translators.filter((translator) => ids.includes(translator.id));
      return yield* Effect.fail(
        new ConfigTranslateError({
          message: `Config translation is ambiguous: ${ids.join(", ")} all detected the source.`,
          remediation: fromRemediation(matched),
        }),
      );
    }
    const selected = translators.find((translator) => translator.id === ids[0]);
    if (selected === undefined) {
      return yield* Effect.fail(
        new ConfigTranslateError({
          message: `Detected translator "${ids[0]}" is not registered.`,
          remediation: fromRemediation(translators),
        }),
      );
    }
    return selected;
  });

export const appConfigTranslate = (
  options: AppConfigTranslateOptions = {},
): Effect.Effect<AppConfigTranslateResult, AppConfigTranslateError, never> =>
  Effect.gen(function* () {
    const resolved = yield* resolveConfigTranslators(options.translators ?? []);

    if (options.list === true) {
      return {
        mode: "list",
        translators: resolved.map((translator) => ({
          id: translator.id,
          summary: translator.summary,
          inputKinds: [...translator.inputKinds],
        })),
      };
    }

    const cwd = options.cwd ?? process.cwd();
    const inputPath = yield* Effect.promise(() => findLandofilePath(cwd));
    if (inputPath === undefined) {
      return yield* Effect.fail(
        new LandofileNotFoundError({
          message: "No .lando.yml found. Run `lando init` to create one before translating.",
          cwd,
        }),
      );
    }

    if (resolved.length === 0) {
      return yield* Effect.fail(
        new ConfigTranslateNoTranslatorsError({
          message: "No config translators are registered, so there is nothing to translate.",
          remediation:
            "Install a config-translator plugin with `lando plugin:add <translator-plugin>`, then re-run `lando app:config:translate`.",
        }),
      );
    }

    const appRoot = dirname(inputPath);
    const detectFiles: ReadonlyArray<PortablePath> =
      options.files !== undefined && options.files.length > 0
        ? yield* Effect.all(options.files.map(parseSourceFilePath))
        : yield* discoverSourceFiles(appRoot);

    if (options.detect === true) {
      const matches = yield* detectConfigTranslators(resolved, {
        appRoot: appRoot as AbsolutePath,
        files: detectFiles,
      });
      return {
        mode: "detect",
        inputPath,
        files: detectFiles.map((file) => String(file)),
        matches: matches.map((match) => ({
          translator: match.translator,
          files: match.files.map((file) => String(file)),
          confidence: match.confidence,
          ...(match.summary === undefined ? {} : { summary: match.summary }),
        })),
      };
    }

    const selected = yield* selectTranslator(resolved, options.from, appRoot as AbsolutePath, detectFiles);

    const content = yield* Effect.tryPromise({
      try: () => Bun.file(inputPath).text(),
      catch: (cause) =>
        new LandofileParseError({
          message: `Could not read ${inputPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
          filePath: inputPath,
          line: undefined,
          column: undefined,
          cause,
        }),
    });
    const parsed = yield* parseLandofile({ file: inputPath, content, cwd: appRoot });
    yield* rejectBetaToolingFeatures(inputPath, parsed);
    const currentDecoded = decodeLandofile(parsed, { onExcessProperty: "error" });
    if (currentDecoded._tag === "Left") {
      return yield* Effect.fail(
        new LandofileParseError({
          message: `Landofile ${inputPath} is not valid: ${String(currentDecoded.left)}`,
          filePath: inputPath,
          line: undefined,
          column: undefined,
          cause: currentDecoded.left,
        }),
      );
    }

    const { fragment, diagnostics } = yield* runConfigTranslators([selected], {
      appRoot: appRoot as AbsolutePath,
      files: detectFiles,
      current: currentDecoded.right,
      options: {},
    });

    const merged = mergeLandofiles([parsed as Record<string, unknown>, fragment as Record<string, unknown>]);
    yield* rejectBetaToolingFeatures(inputPath, merged);
    const mergedDecoded = decodeLandofile(merged, { onExcessProperty: "error" });
    if (mergedDecoded._tag === "Left") {
      return yield* Effect.fail(
        new LandofileParseError({
          message: `Translated Landofile is not valid: ${String(mergedDecoded.left)}`,
          filePath: inputPath,
          line: undefined,
          column: undefined,
          cause: mergedDecoded.left,
        }),
      );
    }

    const canonicalYaml = emitLandofileYaml(merged);

    if (options.write === true) {
      const backupPath = `${inputPath}.bak`;
      yield* writeFile(backupPath, content);
      yield* writeFile(inputPath, canonicalYaml);
      return { mode: "write", inputPath, outputPath: inputPath, backupPath, diagnostics };
    }

    return {
      mode: "preview",
      inputPath,
      translator: selected.id,
      files: detectFiles.map((file) => String(file)),
      content: canonicalYaml,
      diagnostics,
    };
  });

const DIAGNOSTIC_GLYPH: Readonly<Record<string, string>> = {
  generated: "+",
  unsupported: "!",
  "non-portable": "~",
  "needs-review": "?",
};

const diagnosticComment = (diagnostic: TranslateDiagnostic): string => {
  const glyph = DIAGNOSTIC_GLYPH[diagnostic.kind] ?? " ";
  const where = diagnostic.path === undefined ? "" : ` (${diagnostic.path})`;
  return `# ${glyph} ${diagnostic.message}${where}`;
};

const renderList = (translators: ReadonlyArray<TranslatorInfo>): string => {
  if (translators.length === 0) return "No config translators are installed.";
  return translators
    .map((translator) => `${translator.id}\t${translator.inputKinds.join(", ")}\t${translator.summary}`)
    .join("\n");
};

const renderDetect = (matches: ReadonlyArray<ConfigTranslateRenderedMatch>): string => {
  if (matches.length === 0) return "No config translator matches detected.";
  return matches
    .map((match) => `${match.translator}\t${match.confidence}\t${match.files.join(", ")}`)
    .join("\n");
};

const renderPreview = (content: string, diagnostics: ReadonlyArray<TranslateDiagnostic>): string => {
  if (diagnostics.length === 0) return content;
  const trimmed = content.endsWith("\n") ? content : `${content}\n`;
  return `${trimmed}${diagnostics.map(diagnosticComment).join("\n")}`;
};

const renderWrite = (result: WriteResult): string => {
  const header =
    result.backupPath === undefined
      ? `${result.outputPath}: wrote canonical Landofile.`
      : `${result.outputPath}: wrote canonical Landofile (backup at ${result.backupPath}).`;
  const lines = [header];
  for (const diagnostic of result.diagnostics) {
    const glyph = DIAGNOSTIC_GLYPH[diagnostic.kind] ?? " ";
    const where = diagnostic.path === undefined ? "" : ` (${diagnostic.path})`;
    lines.push(`  ${glyph} ${diagnostic.message}${where}`);
  }
  return lines.join("\n");
};

export const renderConfigTranslateResult = (
  result: AppConfigTranslateResult,
  _format: AppConfigTranslateFormat = "yaml",
): string => {
  switch (result.mode) {
    case "list":
      return renderList(result.translators);
    case "detect":
      return renderDetect(result.matches);
    case "preview":
      return renderPreview(result.content, result.diagnostics);
    case "write":
      return renderWrite(result);
  }
};
