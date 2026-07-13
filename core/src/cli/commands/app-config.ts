import { Effect, Either, Schema } from "effect";

import type {
  AppIdReservedError,
  LandofileFormConflictError,
  LandofileIncludeError,
  LandofileLockMismatchError,
  LandofileSandboxError,
  LandofileTimeoutError,
  LandofileValidationError,
  LandofileVersionConstraintError,
} from "@lando/sdk/errors";
import {
  ConfigError,
  LandofileNotFoundError,
  LandofileParseError,
  LandofileWriteValidationError,
  NotImplementedError,
} from "@lando/sdk/errors";
import { LandofileShape } from "@lando/sdk/schema";
import { LandofileService } from "@lando/sdk/services";

import { writeFileAtomicViaRename } from "../../cache/atomic.ts";
import { parseLandofile } from "../../landofile/parser.ts";
import { findDiscoveredLandofilePath } from "../../landofile/service.ts";
import { detectTemplateDirective, renderLandofileTemplate } from "../../landofile/template-render.ts";
import { type EditorRunner, createDefaultEditorRunner } from "../../recipes/prompts/editor-command.ts";
import { loadUserLandofile } from "../app-resolution.ts";
import { getAtPath } from "../config-write/dot-path.ts";
import {
  ConfigWriteResultFields,
  type ValueType,
  applySetMutation,
  applyUnsetMutation,
  decodeIssues,
  emitConfigYaml,
  writeValidationErrorFromIssues,
} from "../config-write/write-core.ts";

export type AppConfigSubcommand = "view" | "get" | "set" | "unset" | "edit" | "validate";

export interface AppConfigOptions {
  readonly subcommand?: AppConfigSubcommand;
  readonly key?: string;
  readonly value?: string;
  readonly type?: ValueType;
  readonly format?: "json" | "table";
  readonly path?: string;
  readonly dryRun?: boolean;
  readonly editor?: string;
  readonly cwd?: string;
  readonly editorRunner?: EditorRunner;
}

export interface AppConfigResult {
  readonly app?: string;
  readonly source?: "resolved";
  readonly landofile?: LandofileShape;
  readonly subcommand?: AppConfigSubcommand;
  readonly key?: string;
  readonly value?: unknown;
  readonly path?: string;
  readonly changed?: boolean;
  readonly dryRun?: boolean;
  readonly valid?: boolean;
  readonly issues?: ReadonlyArray<string>;
  readonly filePath?: string;
}

export const AppConfigResultSchema = Schema.Struct({
  app: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literal("resolved")),
  landofile: Schema.optional(LandofileShape),
  ...ConfigWriteResultFields,
});

type AppConfigError =
  | AppIdReservedError
  | LandofileNotFoundError
  | LandofileFormConflictError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | LandofileWriteValidationError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | LandofileVersionConstraintError
  | ConfigError
  | NotImplementedError;

type AppConfigServices = LandofileService;

const decodeLandofile = Schema.decodeUnknownEither(LandofileShape, { onExcessProperty: "error" });

const missingArgsError = (): LandofileWriteValidationError =>
  new LandofileWriteValidationError({
    message: "`app config set` requires a <key.path> and a <value>.",
    file: "",
    issues: ["Missing key path or value."],
    remediation: "Usage: `lando app config set <key.path> <value> [--type string|number|boolean|json|yaml]`.",
  });

const missingGetKeyError = (): LandofileWriteValidationError =>
  new LandofileWriteValidationError({
    message: "`app config get` requires a <key.path>.",
    file: "",
    issues: ["Missing key path."],
    remediation: "Usage: `lando app config get <key.path>`.",
  });

type WritableAppConfigSubcommand = Extract<AppConfigSubcommand, "set" | "unset" | "edit" | "validate">;

const typeScriptWriteUnsupportedError = (
  subcommand: WritableAppConfigSubcommand,
  filePath: string,
): NotImplementedError =>
  new NotImplementedError({
    message: `\`lando app config ${subcommand}\` does not support the TypeScript Landofile at ${filePath}.`,
    commandId: "app:config",
    remediation:
      "Programmatic `.lando.ts` Landofiles are author-mode TypeScript modules; edit the file directly, or run `lando app config view --source resolved` to inspect resolved values.",
  });

// Discovers both `.lando.yml` and `.lando.ts` (matching the discovery flow
// `LandofileService` runs), then rejects `.lando.ts` with a `NotImplementedError`
// remediation instead of the misleading `LandofileNotFoundError` `findLandofilePath`
// (.lando.yml-only) produced.
const resolveLandofilePath = (
  cwd: string,
  subcommand: WritableAppConfigSubcommand,
): Effect.Effect<
  { readonly inputPath: string; readonly appRoot: string },
  LandofileNotFoundError | LandofileParseError | NotImplementedError
> =>
  Effect.tryPromise({
    try: () => findDiscoveredLandofilePath(cwd),
    catch: (cause) => {
      if (cause instanceof LandofileNotFoundError) return cause;
      if (cause instanceof LandofileParseError) return cause;
      return new LandofileParseError({
        message: cause instanceof Error ? cause.message : `Failed to discover a Landofile from ${cwd}.`,
        filePath: cwd,
        line: undefined,
        column: undefined,
        cause,
      });
    },
  }).pipe(
    Effect.flatMap(({ filePath, appRoot }) =>
      filePath.endsWith(".ts")
        ? Effect.fail(typeScriptWriteUnsupportedError(subcommand, filePath))
        : Effect.succeed({ inputPath: filePath, appRoot }),
    ),
  );

const readLandofileText = (inputPath: string): Effect.Effect<string, ConfigError> =>
  Effect.tryPromise({
    try: () => Bun.file(inputPath).text(),
    catch: (cause) => new ConfigError({ message: `Failed to read ${inputPath}`, path: inputPath, cause }),
  });

// Mirrors the `LandofileService`/`app:config:lint` read step so `validate` parses
// the rendered tree, not raw unrendered template source.
const readRenderedLandofileText = (
  inputPath: string,
): Effect.Effect<string, ConfigError | LandofileParseError> =>
  readLandofileText(inputPath).pipe(
    Effect.flatMap((content) => renderLandofileTemplate({ filePath: inputPath, content })),
  );

const templatedLandofileWriteUnsupportedError = (
  subcommand: WritableAppConfigSubcommand,
  filePath: string,
  engineId: string,
): NotImplementedError =>
  new NotImplementedError({
    message: `\`lando app config ${subcommand}\` does not support the templated Landofile at ${filePath} (\`template: ${engineId}\`).`,
    commandId: "app:config",
    remediation:
      "Writing a mutated tree back through the canonical serializer would discard the `template:` directive and the authored templated source. Run `lando app config edit` to edit the template source directly instead.",
  });

// `set`/`unset` mutate the parsed (rendered) tree and re-emit it through the
// canonical serializer, which would silently discard a `template:` directive and
// the authored templated source. Reject before that happens, matching the
// `.lando.ts` write rejection above; `app config edit` (raw source, no re-emit)
// remains the supported way to change a templated Landofile.
const readWritableLandofileText = (
  inputPath: string,
  subcommand: WritableAppConfigSubcommand,
): Effect.Effect<string, ConfigError | NotImplementedError> =>
  readLandofileText(inputPath).pipe(
    Effect.flatMap((content) => {
      const directive = detectTemplateDirective(content);
      return directive === undefined
        ? Effect.succeed(content)
        : Effect.fail(templatedLandofileWriteUnsupportedError(subcommand, inputPath, directive.engineId));
    }),
  );

const writeLandofileText = (inputPath: string, content: string): Effect.Effect<void, ConfigError> =>
  Effect.tryPromise({
    try: () => writeFileAtomicViaRename(inputPath, content),
    catch: (cause) => new ConfigError({ message: `Failed to write ${inputPath}`, path: inputPath, cause }),
  });

const parseWriteValidationError = (
  inputPath: string,
  error: LandofileParseError,
): LandofileWriteValidationError =>
  new LandofileWriteValidationError({
    message: error.message,
    file: inputPath,
    issues: [error.message],
    remediation: "Fix the YAML syntax so the file parses, then retry. The file was left unchanged.",
  });

export const appConfigSet = (
  options: AppConfigOptions,
): Effect.Effect<AppConfigResult, AppConfigError, never> =>
  Effect.gen(function* () {
    const key = options.key ?? options.path;
    const raw = options.value;
    if (key === undefined || raw === undefined) return yield* Effect.fail(missingArgsError());
    const { inputPath, appRoot } = yield* resolveLandofilePath(options.cwd ?? process.cwd(), "set");
    const content = yield* readWritableLandofileText(inputPath, "set");
    const tree = (yield* parseLandofile({ file: inputPath, content, cwd: appRoot })) as Record<
      string,
      unknown
    >;
    const mutation = applySetMutation({ tree, key, raw, type: options.type ?? "string", file: inputPath });
    if (Either.isLeft(mutation)) return yield* Effect.fail(mutation.left);
    const next = mutation.right.next;
    const issues = decodeIssues(decodeLandofile(next));
    if (issues.length > 0) {
      return yield* Effect.fail(writeValidationErrorFromIssues({ file: inputPath, issues, path: key }));
    }
    const dryRun = options.dryRun === true;
    if (!dryRun) {
      const emitted = emitConfigYaml({ file: inputPath, value: next, path: key });
      if (Either.isLeft(emitted)) return yield* Effect.fail(emitted.left);
      yield* writeLandofileText(inputPath, emitted.right);
    }
    return {
      subcommand: "set",
      key,
      value: mutation.right.value,
      filePath: inputPath,
      changed: true,
      dryRun,
    };
  });

export const appConfigUnset = (
  options: AppConfigOptions,
): Effect.Effect<AppConfigResult, AppConfigError, never> =>
  Effect.gen(function* () {
    const key = options.key ?? options.path;
    if (key === undefined) {
      return yield* Effect.fail(
        new LandofileWriteValidationError({
          message: "`app config unset` requires a <key.path>.",
          file: "",
          issues: ["Missing key path."],
          remediation: "Usage: `lando app config unset <key.path>`.",
        }),
      );
    }
    const { inputPath, appRoot } = yield* resolveLandofilePath(options.cwd ?? process.cwd(), "unset");
    const content = yield* readWritableLandofileText(inputPath, "unset");
    const tree = (yield* parseLandofile({ file: inputPath, content, cwd: appRoot })) as Record<
      string,
      unknown
    >;
    const mutation = applyUnsetMutation({ tree, key, file: inputPath });
    if (Either.isLeft(mutation)) return yield* Effect.fail(mutation.left);
    const next = mutation.right.next;
    const issues = decodeIssues(decodeLandofile(next));
    if (issues.length > 0) {
      return yield* Effect.fail(writeValidationErrorFromIssues({ file: inputPath, issues, path: key }));
    }
    const dryRun = options.dryRun === true;
    if (!dryRun && mutation.right.changed) {
      const emitted = emitConfigYaml({ file: inputPath, value: next, path: key });
      if (Either.isLeft(emitted)) return yield* Effect.fail(emitted.left);
      yield* writeLandofileText(inputPath, emitted.right);
    }
    return { subcommand: "unset", key, filePath: inputPath, changed: mutation.right.changed, dryRun };
  });

export const appConfigValidate = (
  options: AppConfigOptions,
): Effect.Effect<AppConfigResult, AppConfigError, never> =>
  Effect.gen(function* () {
    const { inputPath, appRoot } = yield* resolveLandofilePath(options.cwd ?? process.cwd(), "validate");
    const content = yield* readRenderedLandofileText(inputPath);
    const tree = yield* parseLandofile({ file: inputPath, content, cwd: appRoot });
    const issues = decodeIssues(decodeLandofile(tree));
    if (issues.length > 0) {
      return yield* Effect.fail(writeValidationErrorFromIssues({ file: inputPath, issues }));
    }
    return { subcommand: "validate", filePath: inputPath, valid: true, issues: [] };
  });

export const appConfigEdit = (
  options: AppConfigOptions,
): Effect.Effect<AppConfigResult, AppConfigError, never> =>
  Effect.gen(function* () {
    const { inputPath, appRoot } = yield* resolveLandofilePath(options.cwd ?? process.cwd(), "edit");
    const content = yield* readLandofileText(inputPath);
    const runner =
      options.editorRunner ??
      createDefaultEditorRunner(
        options.editor === undefined
          ? {}
          : { env: { ...process.env, EDITOR: options.editor, VISUAL: options.editor } },
      );
    const edited = yield* Effect.promise(() => runner({ name: "lando-config", content, cwd: appRoot }));
    if (edited.kind === "no-editor") {
      return yield* Effect.fail(
        new LandofileWriteValidationError({
          message: "No editor is configured.",
          file: inputPath,
          issues: ["Neither $VISUAL nor $EDITOR is set."],
          remediation: "Set `$VISUAL` or `$EDITOR`, or pass `--editor <bin>`.",
        }),
      );
    }
    if (edited.kind === "failed") {
      return yield* Effect.fail(
        new LandofileWriteValidationError({
          message: `The editor session failed: ${edited.reason}`,
          file: inputPath,
          issues: [edited.reason],
          remediation:
            "Re-run `lando app config edit` after resolving the editor error. The file was left unchanged.",
        }),
      );
    }
    // Validate against the RENDERED tree (a `template:` directive is a synthetic
    // key that must never reach the strict schema decode below), but persist the
    // user's raw edited text so a template Landofile's directive and templated
    // source survive the save.
    const rendered = yield* renderLandofileTemplate({ filePath: inputPath, content: edited.content }).pipe(
      Effect.catchTag("LandofileParseError", (error) =>
        Effect.fail(parseWriteValidationError(inputPath, error)),
      ),
    );
    const parsed = yield* parseLandofile({ file: inputPath, content: rendered, cwd: appRoot }).pipe(
      Effect.catchTag("LandofileParseError", (error) =>
        Effect.fail(parseWriteValidationError(inputPath, error)),
      ),
    );
    const issues = decodeIssues(decodeLandofile(parsed));
    if (issues.length > 0) {
      return yield* Effect.fail(writeValidationErrorFromIssues({ file: inputPath, issues }));
    }
    yield* writeLandofileText(inputPath, edited.content);
    return { subcommand: "edit", filePath: inputPath, changed: true, valid: true };
  });

export const appConfigGet = (
  options: AppConfigOptions,
): Effect.Effect<AppConfigResult, AppConfigError, AppConfigServices> =>
  Effect.gen(function* () {
    const key = options.key ?? options.path;
    if (key === undefined) return yield* Effect.fail(missingGetKeyError());
    const landofileService = yield* LandofileService;
    const landofile = yield* loadUserLandofile(landofileService);
    return {
      app: landofile.name ?? "",
      source: "resolved",
      subcommand: "get",
      key,
      value: getAtPath(landofile, key),
    };
  });

const tableRender = (result: AppConfigResult): string => {
  const lines: string[] = [`app\t${result.app ?? ""}`];
  const services = Object.keys(result.landofile?.services ?? {});
  if (services.length === 0) lines.push("services\t(none)");
  else lines.push(`services\t${services.join(", ")}`);
  if (result.landofile?.recipe !== undefined) lines.push(`recipe\t${result.landofile.recipe}`);
  return lines.join("\n");
};

const getRender = (result: AppConfigResult): string => {
  if (result.value === undefined) return "";
  if (result.value !== null && typeof result.value === "object") return JSON.stringify(result.value);
  return String(result.value);
};

const writeRender = (result: AppConfigResult): string => {
  const file = result.filePath ?? "";
  switch (result.subcommand) {
    case "set":
      return result.dryRun === true
        ? `${file}: would set ${result.key} (dry run).`
        : `${file}: set ${result.key}.`;
    case "unset":
      if (result.changed !== true) return `${file}: ${result.key} was not present (no change).`;
      return result.dryRun === true
        ? `${file}: would unset ${result.key} (dry run).`
        : `${file}: unset ${result.key}.`;
    case "edit":
      return `${file}: saved edited Landofile.`;
    case "validate":
      return `${file}: valid.`;
    default:
      return tableRender(result);
  }
};

export const renderAppConfigResult = (
  result: AppConfigResult,
  _format: "json" | "table" = "table",
): string => {
  if (result.subcommand === "get") return getRender(result);
  if (result.subcommand !== undefined && result.subcommand !== "view") return writeRender(result);
  return tableRender(result);
};

export const appConfig = (
  options: AppConfigOptions = {},
): Effect.Effect<AppConfigResult, AppConfigError, AppConfigServices> =>
  Effect.gen(function* () {
    const subcommand = options.subcommand ?? "view";
    if (subcommand === "get") return yield* appConfigGet(options);
    if (subcommand === "set") return yield* appConfigSet(options);
    if (subcommand === "unset") return yield* appConfigUnset(options);
    if (subcommand === "edit") return yield* appConfigEdit(options);
    if (subcommand === "validate") return yield* appConfigValidate(options);
    if (subcommand !== "view") {
      return yield* Effect.fail(
        new LandofileWriteValidationError({
          message: `Unknown \`app config\` subcommand: "${subcommand}".`,
          file: "",
          issues: [`Unsupported subcommand: "${subcommand}".`],
          remediation: "Usage: `lando app config [view|set|unset|edit|validate]`.",
        }),
      );
    }

    const landofileService = yield* LandofileService;
    const landofile = yield* loadUserLandofile(landofileService);
    return {
      app: landofile.name ?? "",
      source: "resolved",
      landofile,
    };
  });
