import { Effect, Either, Schema } from "effect";

import type { GlobalAppError, LandofileParseError, LandofileValidationError } from "@lando/sdk/errors";
import { ConfigError, LandofileWriteValidationError } from "@lando/sdk/errors";
import { LandofileShape, type LandofileShape as LandofileShapeType } from "@lando/sdk/schema";
import { FileSystem, type FileSystemError, type GlobalAppPaths, GlobalAppService } from "@lando/sdk/services";

import { writeFileAtomicViaRename } from "../../../cache/atomic.ts";
import { parseLandofile } from "../../../landofile/parser.ts";
import { type EditorRunner, createDefaultEditorRunner } from "../../../recipes/prompts/editor-command.ts";
import {
  type ValueType,
  applySetMutation,
  applyUnsetMutation,
  decodeIssues,
  emitConfigYaml,
  writeValidationErrorFromIssues,
} from "../../config-write/write-core.ts";
import { decodeGlobalLandofile } from "./global-plan.ts";

export type GlobalConfigSubcommand = "view" | "set" | "unset" | "edit" | "validate";

export interface GlobalConfigOptions {
  readonly subcommand?: GlobalConfigSubcommand;
  readonly key?: string;
  readonly value?: string;
  readonly type?: ValueType;
  readonly format?: "json" | "table";
  readonly path?: string;
  readonly dryRun?: boolean;
  readonly editor?: string;
  readonly userLandofilePath?: string;
  readonly editorRunner?: EditorRunner;
}

export interface GlobalConfigResult {
  readonly app?: string;
  readonly source?: "global";
  readonly materialized?: boolean;
  readonly distLandofile?: string;
  readonly userLandofile?: string;
  readonly paths?: GlobalAppPaths;
  readonly landofile?: LandofileShapeType;
  readonly subcommand?: GlobalConfigSubcommand;
  readonly key?: string;
  readonly value?: unknown;
  readonly changed?: boolean;
  readonly dryRun?: boolean;
  readonly valid?: boolean;
  readonly issues?: ReadonlyArray<string>;
  readonly filePath?: string;
}

export const GlobalAppPathsSchema = Schema.Struct({
  root: Schema.String,
  distLandofile: Schema.String,
  userLandofile: Schema.String,
});

export const GlobalConfigResultSchema = Schema.Struct({
  app: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literal("global")),
  materialized: Schema.optional(Schema.Boolean),
  distLandofile: Schema.optional(Schema.String),
  userLandofile: Schema.optional(Schema.String),
  paths: Schema.optional(GlobalAppPathsSchema),
  landofile: Schema.optional(LandofileShape),
  subcommand: Schema.optional(Schema.Literal("view", "set", "unset", "edit", "validate")),
  key: Schema.optional(Schema.String),
  value: Schema.optional(Schema.Unknown),
  changed: Schema.optional(Schema.Boolean),
  dryRun: Schema.optional(Schema.Boolean),
  valid: Schema.optional(Schema.Boolean),
  issues: Schema.optional(Schema.Array(Schema.String)),
  filePath: Schema.optional(Schema.String),
});

type GlobalConfigReadError =
  | GlobalAppError
  | FileSystemError
  | LandofileParseError
  | LandofileValidationError;
type GlobalConfigWriteError = ConfigError | LandofileParseError | LandofileWriteValidationError;

type GlobalConfigServices = FileSystem | GlobalAppService;

const emptyGlobalLandofile: LandofileShapeType = { name: "global", runtime: 4, services: {} };

const decodeLandofile = Schema.decodeUnknownEither(LandofileShape, { onExcessProperty: "error" });

const readGlobalText = (filePath: string): Effect.Effect<string, ConfigError> =>
  Effect.tryPromise({
    try: async () => ((await Bun.file(filePath).exists()) ? Bun.file(filePath).text() : ""),
    catch: (cause) => new ConfigError({ message: `Failed to read ${filePath}`, path: filePath, cause }),
  });

const writeGlobalText = (filePath: string, content: string): Effect.Effect<void, ConfigError> =>
  Effect.tryPromise({
    try: () => writeFileAtomicViaRename(filePath, content),
    catch: (cause) => new ConfigError({ message: `Failed to write ${filePath}`, path: filePath, cause }),
  });

const readGlobalTree = (filePath: string): Effect.Effect<Record<string, unknown>, GlobalConfigWriteError> =>
  Effect.gen(function* () {
    const content = yield* readGlobalText(filePath);
    if (content.trim() === "") return { name: "global", runtime: 4 } as Record<string, unknown>;
    return (yield* parseLandofile({ file: filePath, content, cwd: filePath })) as Record<string, unknown>;
  });

export const globalConfigSet = (
  options: GlobalConfigOptions,
  filePath: string,
): Effect.Effect<GlobalConfigResult, GlobalConfigWriteError, never> =>
  Effect.gen(function* () {
    const key = options.key;
    const raw = options.value;
    if (key === undefined || raw === undefined) {
      return yield* Effect.fail(
        new LandofileWriteValidationError({
          message: "`meta global config set` requires a <key.path> and a <value>.",
          file: filePath,
          issues: ["Missing key path or value."],
          remediation: "Usage: `lando meta global config set <key.path> <value> [--type ...]`.",
        }),
      );
    }
    const tree = yield* readGlobalTree(filePath);
    const mutation = applySetMutation({ tree, key, raw, type: options.type ?? "string", file: filePath });
    if (Either.isLeft(mutation)) return yield* Effect.fail(mutation.left);
    const next = mutation.right.next;
    const issues = decodeIssues(decodeLandofile(next));
    if (issues.length > 0) {
      return yield* Effect.fail(writeValidationErrorFromIssues({ file: filePath, issues, path: key }));
    }
    const dryRun = options.dryRun === true;
    if (!dryRun) {
      const emitted = emitConfigYaml({ file: filePath, value: next, path: key });
      if (Either.isLeft(emitted)) return yield* Effect.fail(emitted.left);
      yield* writeGlobalText(filePath, emitted.right);
    }
    return { subcommand: "set", key, value: mutation.right.value, changed: true, dryRun, filePath };
  });

export const globalConfigUnset = (
  options: GlobalConfigOptions,
  filePath: string,
): Effect.Effect<GlobalConfigResult, GlobalConfigWriteError, never> =>
  Effect.gen(function* () {
    const key = options.key;
    if (key === undefined) {
      return yield* Effect.fail(
        new LandofileWriteValidationError({
          message: "`meta global config unset` requires a <key.path>.",
          file: filePath,
          issues: ["Missing key path."],
          remediation: "Usage: `lando meta global config unset <key.path>`.",
        }),
      );
    }
    const tree = yield* readGlobalTree(filePath);
    const mutation = applyUnsetMutation({ tree, key, file: filePath });
    if (Either.isLeft(mutation)) return yield* Effect.fail(mutation.left);
    const next = mutation.right.next;
    const issues = decodeIssues(decodeLandofile(next));
    if (issues.length > 0) {
      return yield* Effect.fail(writeValidationErrorFromIssues({ file: filePath, issues, path: key }));
    }
    const dryRun = options.dryRun === true;
    if (!dryRun && mutation.right.changed) {
      const emitted = emitConfigYaml({ file: filePath, value: next, path: key });
      if (Either.isLeft(emitted)) return yield* Effect.fail(emitted.left);
      yield* writeGlobalText(filePath, emitted.right);
    }
    return { subcommand: "unset", key, changed: mutation.right.changed, dryRun, filePath };
  });

export const globalConfigValidate = (
  filePath: string,
): Effect.Effect<GlobalConfigResult, GlobalConfigWriteError, never> =>
  Effect.gen(function* () {
    const tree = yield* readGlobalTree(filePath);
    const issues = decodeIssues(decodeLandofile(tree));
    if (issues.length > 0)
      return yield* Effect.fail(writeValidationErrorFromIssues({ file: filePath, issues }));
    return { subcommand: "validate", valid: true, issues: [], filePath };
  });

export const globalConfigEdit = (
  options: GlobalConfigOptions,
  filePath: string,
): Effect.Effect<GlobalConfigResult, GlobalConfigWriteError, never> =>
  Effect.gen(function* () {
    const content = yield* readGlobalText(filePath);
    const seeded = content.trim() === "" ? "name: global\nruntime: 4\n" : content;
    const runner =
      options.editorRunner ??
      createDefaultEditorRunner(
        options.editor === undefined
          ? {}
          : { env: { ...process.env, EDITOR: options.editor, VISUAL: options.editor } },
      );
    const edited = yield* Effect.promise(() =>
      runner({ name: "lando-global-config", content: seeded, cwd: filePath }),
    );
    if (edited.kind === "no-editor") {
      return yield* Effect.fail(
        new LandofileWriteValidationError({
          message: "No editor is configured.",
          file: filePath,
          issues: ["Neither $VISUAL nor $EDITOR is set."],
          remediation: "Set `$VISUAL` or `$EDITOR`, or pass `--editor <bin>`.",
        }),
      );
    }
    if (edited.kind === "failed") {
      return yield* Effect.fail(
        new LandofileWriteValidationError({
          message: `The editor session failed: ${edited.reason}`,
          file: filePath,
          issues: [edited.reason],
          remediation: "Re-run `lando meta global config edit` after resolving the editor error.",
        }),
      );
    }
    const parsed = yield* parseLandofile({ file: filePath, content: edited.content, cwd: filePath }).pipe(
      Effect.catchTag("LandofileParseError", (error) =>
        Effect.fail(
          new LandofileWriteValidationError({
            message: error.message,
            file: filePath,
            issues: [error.message],
            remediation: "Fix the YAML syntax so the file parses, then retry. The file was left unchanged.",
          }),
        ),
      ),
    );
    const issues = decodeIssues(decodeLandofile(parsed));
    if (issues.length > 0)
      return yield* Effect.fail(writeValidationErrorFromIssues({ file: filePath, issues }));
    yield* writeGlobalText(filePath, edited.content);
    return { subcommand: "edit", changed: true, valid: true, filePath };
  });

export const renderGlobalConfigResult = (
  result: GlobalConfigResult,
  _format: "json" | "table" = "table",
): string => {
  void _format;
  switch (result.subcommand) {
    case "set":
      return result.dryRun === true
        ? `${result.filePath ?? ""}: would set ${result.key} (dry run).`
        : `${result.filePath ?? ""}: set ${result.key}.`;
    case "unset":
      if (result.changed !== true)
        return `${result.filePath ?? ""}: ${result.key} was not present (no change).`;
      return result.dryRun === true
        ? `${result.filePath ?? ""}: would unset ${result.key} (dry run).`
        : `${result.filePath ?? ""}: unset ${result.key}.`;
    case "edit":
      return `${result.filePath ?? ""}: saved edited global-app Landofile.`;
    case "validate":
      return `${result.filePath ?? ""}: valid.`;
    default: {
      const services = Object.keys(result.landofile?.services ?? {});
      return [
        `app\t${result.app ?? ""}`,
        `source\t${result.materialized === true ? "generated" : "not installed"}`,
        `dist\t${result.distLandofile ?? ""}`,
        `overlay\t${result.userLandofile ?? ""}`,
        `services\t${services.length === 0 ? "(none)" : services.join(", ")}`,
      ].join("\n");
    }
  }
};

const globalConfigView = (): Effect.Effect<GlobalConfigResult, GlobalConfigReadError, GlobalConfigServices> =>
  Effect.gen(function* () {
    const globalApp = yield* GlobalAppService;
    const fileSystem = yield* FileSystem;
    const paths = yield* globalApp.paths;
    const exists = yield* fileSystem.exists(paths.distLandofile);
    const landofile = exists
      ? yield* fileSystem
          .readText(paths.distLandofile)
          .pipe(
            Effect.flatMap((content) =>
              decodeGlobalLandofile({ file: paths.distLandofile, content, cwd: paths.root }),
            ),
          )
      : emptyGlobalLandofile;

    return {
      app: landofile.name ?? "global",
      source: "global",
      materialized: exists,
      distLandofile: paths.distLandofile,
      userLandofile: paths.userLandofile,
      paths,
      landofile,
    };
  });

export const globalConfig = (
  options: GlobalConfigOptions = {},
): Effect.Effect<GlobalConfigResult, GlobalConfigReadError | GlobalConfigWriteError, GlobalConfigServices> =>
  Effect.gen(function* () {
    const subcommand = options.subcommand ?? "view";
    if (subcommand === "view") return yield* globalConfigView();
    let filePath = options.userLandofilePath;
    if (filePath === undefined) {
      const globalApp = yield* GlobalAppService;
      const paths = yield* globalApp.paths;
      filePath = paths.userLandofile;
    }
    if (subcommand === "set") return yield* globalConfigSet(options, filePath);
    if (subcommand === "unset") return yield* globalConfigUnset(options, filePath);
    if (subcommand === "edit") return yield* globalConfigEdit(options, filePath);
    return yield* globalConfigValidate(filePath);
  });
