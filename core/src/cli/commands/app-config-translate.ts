import { dirname, extname } from "node:path";

import { Effect, Option, Schema } from "effect";

import {
  ConfigTranslateError,
  ConfigTranslateNoTranslatorsError,
  type ConfigTranslatorConflictError,
  LandofileNotFoundError,
  LandofileParseError,
  type NotImplementedError,
  type PluginDescriptorMismatchError,
  type PluginLoadError,
} from "@lando/sdk/errors";
import { emitLandofileYaml } from "@lando/sdk/landofile";
import {
  type ConfigTranslateDocument,
  ConfigTranslateSourceId,
  LandofileAuthoringShape,
  type PortablePath,
} from "@lando/sdk/schema";
import { ConfigTranslatorRegistry, type ConfigTranslatorShape } from "@lando/sdk/services";

import { writeFileAtomicViaRename } from "@lando/engine/cache/atomic";
import {
  detectConfigTranslators,
  resolveConfigTranslators,
  runConfigTranslator,
} from "@lando/landofile/config-translate";
import { findLandofilePath } from "@lando/landofile/discovery";
import { mergeLandofiles } from "@lando/landofile/merge";
import { parseLandofile } from "@lando/landofile/parser";
import { rejectUnsupportedToolingFeatures } from "@lando/landofile/tooling-unsupported";

import type { AppConfigTranslateResult } from "./app-config-translate-output.ts";
import { selectTranslator } from "./app-config-translate-selection.ts";
import {
  discoverSourceFiles,
  parseSourceFilePath,
  resolveContainedSourcePath,
} from "./app-config-translate-sources.ts";
export {
  AppConfigTranslateResultSchema,
  renderConfigTranslateResult,
} from "./app-config-translate-output.ts";
export type { AppConfigTranslateFormat, AppConfigTranslateResult } from "./app-config-translate-output.ts";

export interface AppConfigTranslateOptions {
  readonly cwd?: string;
  readonly write?: boolean;
  readonly list?: boolean;
  readonly detect?: boolean;
  readonly from?: string;
  readonly files?: ReadonlyArray<string>;
  /**
   * Explicit translator set. When omitted, translators come from the
   * `ConfigTranslatorRegistry` of the surrounding `plugins` bootstrap tier;
   * without either, the operation reports no registered translators.
   */
  readonly translators?: ReadonlyArray<ConfigTranslatorShape>;
}

export type AppConfigTranslateError =
  | LandofileNotFoundError
  | LandofileParseError
  | NotImplementedError
  | ConfigTranslateNoTranslatorsError
  | ConfigTranslateError
  | ConfigTranslatorConflictError
  | PluginDescriptorMismatchError
  | PluginLoadError;

/**
 * Registered translators, loaded lazily by the registry only for this explicit
 * conversion request. An absent registry (a host running below the `plugins`
 * tier) yields no translators rather than a bootstrap failure.
 */
const registeredTranslators: Effect.Effect<
  ReadonlyArray<ConfigTranslatorShape>,
  ConfigTranslatorConflictError | PluginDescriptorMismatchError | PluginLoadError
> = Effect.serviceOption(ConfigTranslatorRegistry).pipe(
  Effect.flatMap((registry) => (Option.isSome(registry) ? registry.value.list : Effect.succeed([]))),
);

const decodeLandofile = Schema.decodeUnknownEither(LandofileAuthoringShape);

const writeFile = (path: string, content: string): Effect.Effect<void, ConfigTranslateError> =>
  Effect.tryPromise({
    try: () => writeFileAtomicViaRename(path, content),
    catch: (cause) =>
      new ConfigTranslateError({
        message: `Could not write ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });

export const CONFIG_TRANSLATE_MAX_DOCUMENT_BYTES = 1_048_576;

const readTranslateDocuments = (
  appRoot: string,
  files: ReadonlyArray<PortablePath>,
  options: { readonly explicit: boolean },
): Effect.Effect<ReadonlyArray<ConfigTranslateDocument>, ConfigTranslateError> =>
  Effect.gen(function* () {
    const documents: ConfigTranslateDocument[] = [];
    for (const path of files) {
      const contained = resolveContainedSourcePath(appRoot, path);
      const resolved = options.explicit
        ? yield* contained
        : yield* contained.pipe(
            Effect.match({
              onFailure: () => undefined,
              onSuccess: (value) => value,
            }),
          );
      if (resolved === undefined) continue;
      const bytes = yield* Effect.tryPromise({
        try: () =>
          Bun.file(resolved)
            .slice(0, CONFIG_TRANSLATE_MAX_DOCUMENT_BYTES + 1)
            .bytes(),
        catch: (cause) =>
          new ConfigTranslateError({
            message: `Could not read translation source ${path}.`,
            cause,
            remediation: "Check that the source file exists and is readable.",
          }),
      });
      if (bytes.byteLength > CONFIG_TRANSLATE_MAX_DOCUMENT_BYTES) {
        if (options.explicit)
          return yield* Effect.fail(
            new ConfigTranslateError({
              message: `Translation source ${path} exceeds ${CONFIG_TRANSLATE_MAX_DOCUMENT_BYTES} bytes.`,
              remediation: "Reduce the source file to at most 1 MiB before passing --file.",
            }),
          );
        continue;
      }
      const mediaTypes: Readonly<Record<string, string>> = {
        ".yml": "application/yaml",
        ".yaml": "application/yaml",
        ".json": "application/json",
        ".toml": "application/toml",
      };
      documents.push({
        sourceId: ConfigTranslateSourceId.make(path),
        layerId: "canonical",
        path,
        mediaType: mediaTypes[extname(path).toLowerCase()] ?? "application/octet-stream",
        contentDigest: `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`,
        bytes,
      });
    }
    return documents;
  });

export const appConfigTranslate = (
  options: AppConfigTranslateOptions = {},
): Effect.Effect<AppConfigTranslateResult, AppConfigTranslateError, never> =>
  Effect.gen(function* () {
    const resolved = yield* resolveConfigTranslators(options.translators ?? (yield* registeredTranslators));

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
    const documents = yield* readTranslateDocuments(appRoot, detectFiles, {
      explicit: (options.files?.length ?? 0) > 0,
    });
    const files = documents.map((document) => String(document.sourceId));

    if (options.detect === true) {
      const matches = yield* detectConfigTranslators(resolved, {
        documents,
      });
      return {
        mode: "detect",
        inputPath,
        files,
        matches,
      };
    }

    const selected = yield* selectTranslator(resolved, options.from, documents);

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
    yield* rejectUnsupportedToolingFeatures(inputPath, parsed);
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

    const { outputs, diagnostics, deletions } = yield* runConfigTranslator(selected, {
      _tag: "landofile-document-set",
      documents,
      mode: "full",
      selectedSourceIds: documents.map((document) => document.sourceId),
      currentLowerV4Fragments: [],
      writableLayerIds: ["canonical"],
    });

    const fragments = yield* Schema.decodeUnknown(
      Schema.Array(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
    )([parsed, ...outputs.map((output) => output.fragment)]).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigTranslateError({
            message: "The canonical Landofile and translation fragments must be objects to merge.",
            translator: selected.id,
            cause,
            remediation: "Use a mapping at the Landofile root.",
          }),
      ),
    );
    const merged = mergeLandofiles(fragments);
    yield* rejectUnsupportedToolingFeatures(inputPath, merged);
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
      if (deletions.length > 0)
        return yield* Effect.fail(
          new ConfigTranslateError({
            translator: selected.id,
            message: "Cannot write translation with deletion intents.",
            remediation: "Deletions land with the managed-file transaction.",
          }),
        );
      const backupPath = `${inputPath}.bak`;
      yield* writeFile(backupPath, content);
      yield* writeFile(inputPath, canonicalYaml);
      return { mode: "write", inputPath, outputPath: inputPath, backupPath, diagnostics, deletions };
    }

    return {
      mode: "preview",
      inputPath,
      translator: selected.id,
      files,
      content: canonicalYaml,
      diagnostics,
      deletions,
    };
  });
