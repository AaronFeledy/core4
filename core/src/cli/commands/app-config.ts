import { type AppConfigResult, AppConfigResultSchema } from "@lando/engine/operations/app-config-result";
import { type AppConfigViewOptions, appConfigView } from "@lando/engine/operations/app-config-view";
import * as Writes from "@lando/engine/operations/app-config-write";
import { collectLandofileRedactionTokens } from "@lando/engine/services/app-plan-redaction";
import { LandofileWriteValidationError } from "@lando/sdk/errors";
import { emitLandofileYaml, isPlainRecord } from "@lando/sdk/landofile";
import { LandofileShape } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { createDefaultEditorRunner } from "../../recipes/prompts/editor-command";
import { configRedactionTokens } from "./config-redaction";
import { renderConfigWriteResult } from "./config-write-render";
import { hostEventStatusesForPlan, renderHostEventStatuses } from "./host-event-status";

export { AppConfigResultSchema, type AppConfigResult };
export type AppConfigSubcommand = NonNullable<AppConfigViewOptions["subcommand"]>;
export interface AppConfigOptions extends AppConfigViewOptions, Writes.AppConfigWriteOptions {
  readonly format?: "json" | "yaml" | "table";
  readonly editor?: string;
}

export const appConfigRedactionTokens = (result: unknown): readonly string[] => {
  if (result === null || typeof result !== "object") return [];
  if ("redactionTokens" in result && Array.isArray(result.redactionTokens))
    return result.redactionTokens.filter((token): token is string => typeof token === "string");
  if ("landofile" in result && Schema.is(LandofileShape)(result.landofile))
    return collectLandofileRedactionTokens(result.landofile);
  return configRedactionTokens(result);
};

export const appConfigSet = (options: AppConfigOptions) => Writes.appConfigSet(options);
export const appConfigUnset = (options: AppConfigOptions) => Writes.appConfigUnset(options);
export const appConfigValidate = (options: AppConfigOptions) => Writes.appConfigValidate(options);
export const appConfigEdit = (options: AppConfigOptions) =>
  Writes.appConfigEdit({
    ...options,
    editorRunner:
      options.editorRunner ??
      createDefaultEditorRunner(
        options.editor === undefined
          ? {}
          : { env: { ...process.env, EDITOR: options.editor, VISUAL: options.editor } },
      ),
  });

export const appConfigGet = (options: AppConfigOptions) =>
  appConfigView({ ...options, subcommand: "get" }).pipe(
    Effect.flatMap((inspected) =>
      Schema.decodeUnknownEffect(Schema.toType(AppConfigResultSchema))(inspected).pipe(
        Effect.orDie,
        Effect.map((result) => ({ ...result, redactionTokens: inspected.redactionTokens })),
      ),
    ),
  );

/**
 * Read the table's metadata straight from the authored mapping. A merged
 * view is source data, so it may still carry unresolved expressions in typed
 * fields; decoding it as a finished Landofile would hide the authored
 * name, services, and recipe. Anything that is not a mapping yields no metadata.
 */
const authoredMetadata = (landofile: unknown) => {
  const mapping = isPlainRecord(landofile) ? landofile : {};
  const recipe = isPlainRecord(mapping.recipe) ? mapping.recipe.id : mapping.recipe;
  return {
    name: typeof mapping.name === "string" ? mapping.name : undefined,
    services: Object.keys(isPlainRecord(mapping.services) ? mapping.services : {}),
    recipe: typeof recipe === "string" ? recipe : undefined,
  };
};

const tableRender = (result: AppConfigResult): string => {
  if ("layers" in result)
    return result.layers
      .map(
        (layer) =>
          `${layer.layer}\t${layer.file}\t${layer.document === undefined ? "" : JSON.stringify(layer.document)}`,
      )
      .join("\n");
  if ("value" in result)
    return result.value === undefined
      ? ""
      : result.value !== null && typeof result.value === "object"
        ? JSON.stringify(result.value)
        : String(result.value);
  const authored = authoredMetadata("landofile" in result ? result.landofile : undefined);
  const app = ("app" in result ? result.app : undefined) ?? authored.name ?? "";
  const { services } = authored;
  const lines = [`app\t${app}`, `services\t${services.length === 0 ? "(none)" : services.join(", ")}`];
  if (authored.recipe !== undefined) lines.push(`recipe\t${authored.recipe}`);
  lines.push(...renderHostEventStatuses("hostEvents" in result ? (result.hostEvents ?? []) : []));
  return lines.join("\n");
};

export const renderAppConfigResult = (
  result: AppConfigResult,
  format: "json" | "yaml" | "table" = "table",
): string => {
  if ("subcommand" in result && result.subcommand !== undefined) {
    if (result.subcommand === "get")
      return result.value === undefined
        ? ""
        : result.value !== null && typeof result.value === "object"
          ? JSON.stringify(result.value)
          : String(result.value);
    return (
      renderConfigWriteResult({
        file: result.filePath,
        subcommand: result.subcommand,
        key: "key" in result ? result.key : undefined,
        changed: "changed" in result ? result.changed : undefined,
        dryRun: result.dryRun,
        editSavedLabel: "Landofile",
        value: "value" in result ? result.value : undefined,
      }) ?? tableRender(result)
    );
  }
  if (format === "yaml" && result.source === "resolved" && "landofile" in result)
    return emitLandofileYaml({ ...Schema.encodeSync(LandofileShape)(result.landofile) });
  if ("path" in result && !("layers" in result) && !("value" in result)) return "";
  return tableRender(result);
};

export const appConfig = Effect.fn("AppConfig.run")(function* (options: AppConfigOptions = {}) {
  switch (options.subcommand ?? "view") {
    case "set":
      return yield* appConfigSet(options);
    case "unset":
      return yield* appConfigUnset(options);
    case "validate":
      return yield* appConfigValidate(options);
    case "edit":
      return yield* appConfigEdit(options);
    case "get":
      return yield* appConfigGet(options);
    case "view": {
      const inspected = yield* appConfigView(options);
      const decoded = yield* Schema.decodeUnknownEffect(Schema.toType(AppConfigResultSchema))(inspected).pipe(
        Effect.orDie,
      );
      const result = { ...decoded, redactionTokens: inspected.redactionTokens };
      if (!("source" in result) || result.source !== "resolved" || !("landofile" in result)) return result;
      const hostEvents = yield* hostEventStatusesForPlan({
        name: result.landofile.name ?? "",
        root: options.cwd ?? process.cwd(),
        services: result.landofile.services ?? {},
        ...(result.landofile.events === undefined ? {} : { events: result.landofile.events }),
      });
      return { ...result, ...(hostEvents.length === 0 ? {} : { hostEvents }) };
    }
    default:
      return yield* Effect.fail(
        new LandofileWriteValidationError({
          message: `Unknown \`app config\` subcommand: "${options.subcommand}".`,
          file: "",
          issues: [],
          remediation: "Usage: `lando app config [view|get|set|unset|edit|validate]`.",
        }),
      );
  }
});
