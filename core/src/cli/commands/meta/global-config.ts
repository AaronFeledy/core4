import { dirname } from "node:path";
import { ConfigDescribeResultSchema, describeConfigKey } from "@lando/engine/config-write/key-schema";
import { type GlobalMutationServices, withGlobalMutation } from "@lando/engine/global-app/mutation";
import { CliInvocation } from "../../../runtime/invocation-context";

import { Effect, Schema } from "effect";

import { LandofileWriteValidationError } from "@lando/sdk/errors";
import { AbsolutePath, LandofileShape, type LandofileShape as LandofileShapeType } from "@lando/sdk/schema";
import { GlobalAppService } from "@lando/sdk/services";

import { runEditVerb, runSetVerb, runUnsetVerb } from "@lando/engine/config-write/verbs";
import type { ValueType } from "@lando/engine/config-write/write-core";
import { readGlobalLandofile } from "@lando/engine/operations/global-plan";
import { validationIssue } from "@lando/sdk/schema";
import { type EditorRunner, createDefaultEditorRunner } from "../../../recipes/prompts/editor-command";
import { renderConfigKeyDescription } from "../config-key-render";
import { renderConfigWriteResult } from "../config-write-render";
import {
  compileGlobalConfigDocument,
  globalConfigDocument,
  requireMutableGlobalLandofile,
} from "./global-config-document";

export const GLOBAL_CONFIG_SUBCOMMANDS = ["view", "set", "unset", "edit", "validate", "describe"] as const;
export type GlobalConfigSubcommand = Exclude<(typeof GLOBAL_CONFIG_SUBCOMMANDS)[number], "describe">;

export interface GlobalConfigOptions {
  /** `describe` is schema-only; `runGlobalConfig` dispatches it without the global app. */
  readonly subcommand?: (typeof GLOBAL_CONFIG_SUBCOMMANDS)[number];
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

export const GlobalAppPathsSchema = Schema.Struct({
  root: AbsolutePath,
  distLandofile: AbsolutePath,
  userLandofile: AbsolutePath,
});

const GlobalConfigValueResultSchema = Schema.Struct({
  app: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.Literal("global")),
  materialized: Schema.optionalKey(Schema.Boolean),
  distLandofile: Schema.optionalKey(Schema.String),
  userLandofile: Schema.optionalKey(Schema.String),
  paths: Schema.optionalKey(GlobalAppPathsSchema),
  landofile: Schema.optionalKey(LandofileShape),
  subcommand: Schema.optionalKey(Schema.Literals(["view", "set", "unset", "edit", "validate"])),
  key: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.Unknown),
  changed: Schema.optionalKey(Schema.Boolean),
  dryRun: Schema.optionalKey(Schema.Boolean),
  valid: Schema.optionalKey(Schema.Boolean),
  issues: Schema.optionalKey(Schema.Array(Schema.String)),
  filePath: Schema.optionalKey(Schema.String),
});
export const GlobalConfigResultSchema = Schema.Union([
  GlobalConfigValueResultSchema,
  ConfigDescribeResultSchema,
]);
export type GlobalConfigResult = typeof GlobalConfigResultSchema.Type;

type GlobalConfigReadError = Effect.Error<ReturnType<typeof readGlobalLandofile>>;
type GlobalConfigWriteError =
  | import("@lando/sdk/errors").GlobalAppError
  | Effect.Error<ReturnType<typeof compileGlobalConfigDocument>>
  | Effect.Error<ReturnType<typeof requireMutableGlobalLandofile>>;

type GlobalConfigServices = Effect.Services<ReturnType<typeof readGlobalLandofile>> | GlobalMutationServices;
type GlobalConfigWriteReturn = Effect.fn.Return<
  typeof GlobalConfigValueResultSchema.Type,
  GlobalConfigWriteError,
  Effect.Services<ReturnType<typeof compileGlobalConfigDocument>>
>;
type GlobalConfigMutationReturn = Effect.fn.Return<
  typeof GlobalConfigValueResultSchema.Type,
  GlobalConfigWriteError,
  Effect.Services<ReturnType<typeof compileGlobalConfigDocument>> | GlobalMutationServices
>;

const emptyGlobalLandofile: LandofileShapeType = { name: "global", runtime: 4, services: {} };

export const globalConfigSet = Effect.fn("GlobalConfig.set")(
  function* (options: GlobalConfigOptions, filePath: string): GlobalConfigMutationReturn {
    yield* requireMutableGlobalLandofile(filePath, "set");
    const key = options.key ?? options.path;
    const raw = options.value;
    if (key === undefined || raw === undefined) {
      return yield* Effect.fail(
        new LandofileWriteValidationError({
          message: "`lando global:config set` requires a <key.path> and a <value>.",
          file: filePath,
          issues: [validationIssue([], "Missing key path or value.")],
          remediation: "Usage: `lando global:config set <key.path> <value> [--type ...]`.",
        }),
      );
    }
    const outcome = yield* runSetVerb({
      ...globalConfigDocument(filePath, "set"),
      key,
      raw,
      type: options.type,
      dryRun: options.dryRun === true,
    });
    return {
      subcommand: "set",
      key,
      value: outcome.value,
      changed: outcome.changed,
      dryRun: outcome.dryRun,
      filePath,
    };
  },
  (effect, _options: GlobalConfigOptions, _filePath: string) => withGlobalMutation(effect),
);

export const globalConfigUnset = Effect.fn("GlobalConfig.unset")(
  function* (options: GlobalConfigOptions, filePath: string): GlobalConfigMutationReturn {
    yield* requireMutableGlobalLandofile(filePath, "unset");
    const key = options.key ?? options.path;
    if (key === undefined) {
      return yield* Effect.fail(
        new LandofileWriteValidationError({
          message: "`lando global:config unset` requires a <key.path>.",
          file: filePath,
          issues: [validationIssue([], "Missing key path.")],
          remediation: "Usage: `lando global:config unset <key.path>`.",
        }),
      );
    }
    const outcome = yield* runUnsetVerb({
      ...globalConfigDocument(filePath, "unset"),
      key,
      dryRun: options.dryRun === true,
    });
    return { subcommand: "unset", key, changed: outcome.changed, dryRun: outcome.dryRun, filePath };
  },
  (effect, _options: GlobalConfigOptions, _filePath: string) => withGlobalMutation(effect),
);

export const globalConfigValidate = Effect.fn("GlobalConfig.validate")(function* (
  filePath: string,
): GlobalConfigWriteReturn {
  yield* compileGlobalConfigDocument(filePath);
  return { subcommand: "validate", valid: true, issues: [], filePath };
});

export const globalConfigEdit = Effect.fn("GlobalConfig.edit")(function* (
  options: GlobalConfigOptions,
  filePath: string,
): GlobalConfigMutationReturn {
  yield* requireMutableGlobalLandofile(filePath, "edit");
  const env = (yield* CliInvocation).env;
  const runner =
    options.editorRunner ??
    createDefaultEditorRunner(
      options.editor === undefined
        ? { env }
        : { env: { ...env, EDITOR: options.editor, VISUAL: options.editor } },
    );
  const document = globalConfigDocument(filePath, "edit");
  const source = yield* document.readText;
  const edited = yield* Effect.promise(() =>
    runner({
      name: "lando-global-config",
      content: source.trim() === "" ? "name: global\nruntime: 4\n" : source,
      cwd: dirname(filePath),
    }),
  );
  const outcome = yield* withGlobalMutation(
    Effect.gen(function* () {
      const current = yield* document.readText;
      if (current !== source)
        return yield* Effect.fail(
          new LandofileWriteValidationError({
            file: filePath,
            message: "The global Landofile changed while the editor was open.",
            issues: [validationIssue([], "Another command changed the global Landofile.")],
            remediation: "Reopen `lando global:config edit` and apply your changes to the current file.",
          }),
        );
      return yield* runEditVerb({
        ...document,
        readText: Effect.succeed(source),
        dryRun: options.dryRun === true,
        openEditor: () => Effect.succeed(edited),
      });
    }),
  );
  return { subcommand: "edit", ...outcome, filePath };
});

export const renderGlobalConfigResult = (
  result: GlobalConfigResult,
  _format: "json" | "table" = "table",
): string => {
  void _format;
  if (result.subcommand === "describe") return renderConfigKeyDescription(result, "Global Landofile");
  const writeResult = renderConfigWriteResult({
    file: result.filePath ?? "",
    subcommand: result.subcommand,
    key: result.key,
    changed: result.changed,
    dryRun: result.dryRun,
    editSavedLabel: "global-app Landofile",
    value: result.value,
  });
  if (writeResult !== undefined) return writeResult;
  const services = Object.keys(result.landofile?.services ?? {});
  return [
    `app\t${result.app ?? ""}`,
    `source\t${result.materialized === true ? "generated" : "not installed"}`,
    `dist\t${result.distLandofile ?? ""}`,
    `overlay\t${result.userLandofile ?? ""}`,
    `services\t${services.length === 0 ? "(none)" : services.join(", ")}`,
  ].join("\n");
};

/** Describes a global Landofile key from the Landofile schema; reads no global app state. */
export const describeGlobalConfig = (options: Pick<GlobalConfigOptions, "key" | "path">) =>
  describeConfigKey("global", options.key ?? options.path).pipe(
    Effect.map((description) => ({ subcommand: "describe" as const, ...description })),
  );

const globalConfigView = Effect.fnUntraced(function* (): Effect.fn.Return<
  typeof GlobalConfigValueResultSchema.Type,
  GlobalConfigReadError,
  GlobalConfigServices
> {
  const loaded = yield* readGlobalLandofile();
  const { paths } = loaded;
  const landofile = loaded.materialized ? loaded.landofile.document : emptyGlobalLandofile;

  return {
    app: landofile.name ?? "global",
    source: "global",
    materialized: loaded.materialized,
    distLandofile: paths.distLandofile,
    userLandofile: paths.userLandofile,
    paths,
    landofile,
  };
});

export const globalConfig = Effect.fn("GlobalConfig.run")(function* (
  options: GlobalConfigOptions & { readonly subcommand?: GlobalConfigSubcommand } = {},
): Effect.fn.Return<
  typeof GlobalConfigValueResultSchema.Type,
  GlobalConfigReadError | GlobalConfigWriteError,
  GlobalConfigServices
> {
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
  if (subcommand === "validate") return yield* globalConfigValidate(filePath);
  const exhaustive: never = subcommand;
  return exhaustive;
});
