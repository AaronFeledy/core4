import { dirname } from "node:path";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";

import { Effect, Option } from "effect";

import {
  ConfigTranslateError,
  ConfigTranslateNoTranslatorsError,
  type ConfigTranslatorConflictError,
  type LandofileFormConflictError,
  LandofileNotFoundError,
  type LandofileParseError,
  type NotImplementedError,
  type PluginDescriptorMismatchError,
  type PluginLoadError,
} from "@lando/sdk/errors";
import { type ConfigTranslateDocument, ConfigTranslateSourceId, type PortablePath } from "@lando/sdk/schema";
import { ConfigTranslatorRegistry, type ConfigTranslatorShape } from "@lando/sdk/services";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";

import {
  detectConfigTranslators,
  resolveConfigTranslators,
  runConfigTranslator,
} from "@lando/landofile/config-translate";
import { findLandofilePath } from "@lando/landofile/discovery";

import {
  buildDocumentSetShape,
  layerForSourcePath,
  lowerV4LayerFragments,
  orderSourcePaths,
} from "./app-config-translate-document-set.ts";
import { encodeTranslateOutputs } from "./app-config-translate-encode.ts";
import type { AppConfigTranslateResult } from "./app-config-translate-output.ts";
import { renderTranslateTargets } from "./app-config-translate-output.ts";
import { selectTranslator } from "./app-config-translate-selection.ts";
import {
  discoverSourceFiles,
  mediaTypeForSourcePath,
  parseSourceFilePath,
  rejectUndiscoveredSources,
  resolveContainedSourcePath,
} from "./app-config-translate-sources.ts";
import { writeTranslateTargets } from "./app-config-translate-write.ts";
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
  readonly to?: string;
  readonly files?: ReadonlyArray<string>;
  /**
   * Explicit translator set. When omitted, translators come from the
   * `ConfigTranslatorRegistry` of the surrounding `plugins` bootstrap tier;
   * without either, the operation reports no registered translators.
   */
  readonly translators?: ReadonlyArray<ConfigTranslatorShape>;
  readonly privateFileAccess?: PrivateFileAccess;
}

export type AppConfigTranslateError =
  | LandofileNotFoundError
  | LandofileFormConflictError
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

export const CONFIG_TRANSLATE_MAX_DOCUMENT_BYTES = 1_048_576;

const readTranslateDocuments = (
  appRoot: string,
  files: ReadonlyArray<PortablePath>,
  explicit: ReadonlyArray<PortablePath>,
): Effect.Effect<ReadonlyArray<ConfigTranslateDocument>, ConfigTranslateError> =>
  Effect.gen(function* () {
    const documents: ConfigTranslateDocument[] = [];
    for (const path of files) {
      const contained = resolveContainedSourcePath(appRoot, path);
      const resolved = explicit.includes(path)
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
        if (explicit.includes(path))
          return yield* Effect.fail(
            new ConfigTranslateError({
              message: `Translation source ${path} exceeds ${CONFIG_TRANSLATE_MAX_DOCUMENT_BYTES} bytes.`,
              remediation: "Reduce the source file to at most 1 MiB before passing --file.",
            }),
          );
        continue;
      }
      documents.push({
        sourceId: ConfigTranslateSourceId.make(path),
        layerId: layerForSourcePath(path),
        path,
        mediaType: mediaTypeForSourcePath(path),
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
    const discovered = yield* discoverSourceFiles(appRoot);
    const explicit = yield* Effect.all((options.files ?? []).map(parseSourceFilePath));
    yield* rejectUndiscoveredSources(appRoot, discovered, explicit);
    const paths = orderSourcePaths(discovered);
    const documents = yield* readTranslateDocuments(appRoot, paths, explicit);
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

    const targetId = options.to ?? "lando4";
    const target = resolved.find((translator) => translator.id === targetId);
    if (target?.encode === undefined)
      return yield* Effect.fail(
        new ConfigTranslateError({
          message: `Invalid --to target "${targetId}": an encoder is required.`,
          remediation: `Choose --to from: ${resolved
            .filter((translator) => translator.encode !== undefined)
            .map((translator) => translator.id)
            .join(", ")}.`,
        }),
      );

    const selected = yield* selectTranslator(resolved, options.from, documents);

    const shape = buildDocumentSetShape({
      sourceIds: files,
      selected: explicit.length === 0 ? undefined : explicit.map(String),
    });
    const currentLowerV4Fragments =
      shape.mode === "single-layer"
        ? yield* lowerV4LayerFragments({
            appRoot,
            selectedSourceIds: shape.selectedSourceIds,
            documents,
          })
        : [];
    const {
      outputs,
      diagnostics: frontendDiagnostics,
      deletions,
    } = yield* runConfigTranslator(selected, {
      _tag: "landofile-document-set",
      documents,
      mode: shape.mode,
      selectedSourceIds: shape.selectedSourceIds.map((sourceId) => ConfigTranslateSourceId.make(sourceId)),
      currentLowerV4Fragments,
      writableLayerIds: shape.writableLayerIds,
    });

    const encoded = frontendDiagnostics.some((diagnostic) => diagnostic.kind === "unsupported")
      ? []
      : yield* encodeTranslateOutputs(
          { appRoot, inputPath },
          { outputs, currentLowerV4Fragments },
          target.encode,
        );
    const service = yield* Effect.serviceOption(RedactionService);
    const redactor = Option.isSome(service)
      ? yield* service.value.forProfile("secrets")
      : createStandaloneRedactor("secrets");
    const diagnostics = [...frontendDiagnostics, ...encoded.flatMap((result) => result.diagnostics)].map(
      (diagnostic) => ({
        ...diagnostic,
        message: redactor.redactString(diagnostic.message),
        ...(diagnostic.remediation === undefined
          ? {}
          : { remediation: redactor.redactString(diagnostic.remediation) }),
      }),
    );
    const targets = diagnostics.some((diagnostic) => diagnostic.kind === "unsupported")
      ? []
      : encoded.map((result) => result.target);
    const canonicalYaml = renderTranslateTargets(targets);

    const preview = {
      mode: "preview" as const,
      inputPath,
      translator: selected.id,
      target: targetId,
      targets,
      files,
      content: canonicalYaml,
      diagnostics,
      deletions,
    };
    if (options.write !== true) return preview;
    if (options.privateFileAccess === undefined) {
      return yield* Effect.fail(
        new ConfigTranslateError({
          message: "Private file access is unavailable for translated configuration writes.",
          remediation: "Run the translation through the Lando runtime.",
        }),
      );
    }
    return yield* writeTranslateTargets({
      appRoot,
      preview,
      shape,
      documents,
      privateFileAccess: options.privateFileAccess,
    });
  });
