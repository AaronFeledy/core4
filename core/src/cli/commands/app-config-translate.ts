import { basename, dirname } from "node:path";

import { Effect, Schema } from "effect";

import type { ConfigTranslatorConflictError } from "@lando/sdk/errors";
import {
  ConfigTranslateError,
  ConfigTranslateNoTranslatorsError,
  LandofileNotFoundError,
  LandofileParseError,
} from "@lando/sdk/errors";
import type { AbsolutePath, PortablePath } from "@lando/sdk/schema";
import { LandofileShape } from "@lando/sdk/schema";
import type { ConfigTranslateDiagnostic, ConfigTranslatorShape } from "@lando/sdk/services";

import { writeFileAtomicViaRename } from "../../cache/atomic.ts";
import { runConfigTranslators } from "../../landofile/config-translate.ts";
import { findLandofilePath } from "../../landofile/discovery.ts";
import { mergeLandofiles } from "../../landofile/merge.ts";
import { parseLandofile } from "../../landofile/parser.ts";
import { emitLandofileYaml } from "../../landofile/yaml-emit.ts";

export type AppConfigTranslateFormat = "text" | "json";

export interface AppConfigTranslateOptions {
  readonly cwd?: string;
  readonly write?: boolean;
  readonly translators?: ReadonlyArray<ConfigTranslatorShape>;
}

export interface AppConfigTranslateResult {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly mode: "canonical" | "write";
  readonly backupPath?: string;
  readonly diagnostics: ReadonlyArray<ConfigTranslateDiagnostic>;
}

export type AppConfigTranslateError =
  | LandofileNotFoundError
  | LandofileParseError
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

export const appConfigTranslate = (
  options: AppConfigTranslateOptions = {},
): Effect.Effect<AppConfigTranslateResult, AppConfigTranslateError, never> =>
  Effect.gen(function* () {
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

    const translators = options.translators ?? [];
    if (translators.length === 0) {
      return yield* Effect.fail(
        new ConfigTranslateNoTranslatorsError({
          message: "No config translators are registered, so there is nothing to translate.",
          remediation:
            "Install a config-translator plugin with `lando plugin:add <translator-plugin>`, then re-run `lando app:config:translate`.",
        }),
      );
    }

    const appRoot = dirname(inputPath);
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

    const { fragment, diagnostics } = yield* runConfigTranslators(translators, {
      appRoot: appRoot as AbsolutePath,
      files: [basename(inputPath) as PortablePath],
      current: currentDecoded.right,
      options: {},
    });

    const merged = mergeLandofiles([parsed as Record<string, unknown>, fragment as Record<string, unknown>]);
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
      return { inputPath, outputPath: inputPath, mode: "write", backupPath, diagnostics };
    }

    const outputPath = `${inputPath}.canonical`;
    yield* writeFile(outputPath, canonicalYaml);
    return { inputPath, outputPath, mode: "canonical", diagnostics };
  });

const DIAGNOSTIC_GLYPH: Readonly<Record<string, string>> = {
  generated: "+",
  unsupported: "!",
  "non-portable": "~",
  "needs-review": "?",
};

const textRender = (result: AppConfigTranslateResult): string => {
  const header =
    result.mode === "write"
      ? `${result.outputPath}: wrote canonical Landofile (backup at ${result.backupPath}).`
      : `${result.outputPath}: wrote canonical Landofile.`;
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
  format: AppConfigTranslateFormat = "text",
): string => (format === "json" ? JSON.stringify(result, null, 2) : textRender(result));
