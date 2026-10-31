import { readAppCommandCacheForCwdDetailed } from "@lando/engine/cache/command-index-writer";
import { ToolingDisabledError } from "@lando/sdk/errors";
import { Effect, Exit, Layer } from "effect";
import { resolveBuiltInCommand } from "./built-in-command-registry";
import { type HelpTopic, isHelpTopic, renderColdAllHelp, renderColdTopicHelp } from "./cold-path-output";
import {
  pluginRowsForCache,
  printCommandHelp,
  printHelpCatalogJson,
  printRootHelp,
  printToolingHelp,
  thisAppHelpRowsFromCache,
} from "./compiled-help";
import {
  activeRendererMode,
  activeResultFormat,
  emitResultLine,
  runCompiledCommand,
} from "./compiled-runtime";
import { escapeDiagnosticText } from "./diagnostic-text";
import { renderAliasResolutionFailure } from "./dynamic-tooling";
import { validateCommandCliFlags } from "./flag-value-validation";
import { isEnvelopeResultFormat } from "./format-flags";
import { redactHelpText } from "./help-redaction";
import { interruptOnAbort } from "./interrupt-on-abort";
import { type PluginCommandCatalog, createPluginCommandCatalog } from "./plugin-command-catalog";
import { pluginHelpRows, printPluginTopicHelp, tryPluginCommandHelp } from "./plugin-command-help";
import { renderPreCommandFailure } from "./spec/command-boundary";
import { toolingMetadataStatus } from "./tooling-cache-status";
import { resolveToolingRoute, toolingRouteError } from "./tooling-router";
import { unknownCommandError } from "./unknown-command-error";

const readHelpCache = async () => {
  const exit = await Effect.runPromiseExit(
    Effect.result(readAppCommandCacheForCwdDetailed({ includeScriptInventory: true })),
  );
  if (Exit.isFailure(exit)) throw exit.cause;
  const result = exit.value;
  switch (result._tag) {
    case "Failure":
      await renderAliasResolutionFailure(result.failure);
      return undefined;
    case "Success":
      return {
        cache: result.success.status === "fresh" ? result.success.payload : null,
        toolingMetadata: toolingMetadataStatus(result.success),
      };
    default:
      return result satisfies never;
  }
};

export const printAllHelp = async (
  catalog: PluginCommandCatalog = createPluginCommandCatalog(),
): Promise<void> => {
  if (isEnvelopeResultFormat(activeResultFormat)) return printHelpCatalogPage(catalog);
  const result = await readHelpCache();
  if (result === undefined) return;
  const { cache, toolingMetadata } = result;
  const plugins = await catalog.list();
  await emitResultLine(
    await redactHelpText(
      renderColdAllHelp({
        thisAppRows: cache === null ? [] : thisAppHelpRowsFromCache(cache),
        toolingMetadata,
        pluginRows: pluginHelpRows(pluginRowsForCache(plugins.rows, cache)),
        ...(plugins.metadata.status === "unavailable"
          ? {
              pluginNotice: `Plugin commands unavailable: ${plugins.metadata.message} ${plugins.metadata.remediation ?? ""}`,
            }
          : (plugins.metadata.diagnostics?.length ?? 0) > 0
            ? {
                pluginNotice: `Plugin command metadata has ${plugins.metadata.diagnostics?.length} diagnostic(s); use --format=json for details.`,
              }
            : {}),
        ...(cache?.aliasPolicy === undefined ? {} : { aliasPolicy: cache.aliasPolicy }),
      }),
    ),
  );
};

const printTopicHelp = async (topic: HelpTopic, catalog: PluginCommandCatalog): Promise<void> => {
  if (isEnvelopeResultFormat(activeResultFormat)) return printHelpCatalogPage(catalog);
  const result = await readHelpCache();
  if (result === undefined) return;
  const { cache } = result;
  await emitResultLine(
    renderColdTopicHelp(topic, cache?.aliasPolicy === undefined ? {} : { aliasPolicy: cache.aliasPolicy }),
  );
};

export const rejectUnknownHelpFlags = async (argv: ReadonlyArray<string>): Promise<boolean> => {
  const flagError = validateCommandCliFlags({
    commandId: "cli:help",
    argv,
    definitions: { all: { type: "boolean" }, help: { type: "boolean", char: "h" } },
    allowUnknownFlags: false,
  });
  if (flagError === undefined) return false;
  await runCompiledCommand(Effect.fail(flagError), Layer.empty, () => undefined, {
    failureExitCode: () => 2,
    preCommand: true,
  });
  return true;
};

export const printRootHelpPage = async (
  catalog: PluginCommandCatalog = createPluginCommandCatalog(),
): Promise<void> => {
  if (isEnvelopeResultFormat(activeResultFormat)) return printHelpCatalogPage(catalog);
  const result = await readHelpCache();
  if (result !== undefined) await printRootHelp(undefined, result.cache, result.toolingMetadata);
};

export const printHelpCatalogPage = async (
  catalog: PluginCommandCatalog = createPluginCommandCatalog(),
): Promise<void> => {
  const result = await readHelpCache();
  if (result === undefined) return;
  await printHelpCatalogJson(
    result.cache,
    isEnvelopeResultFormat(activeResultFormat) ? activeResultFormat : "json",
    result.toolingMetadata,
    await catalog.list(),
  );
};

export const dispatchHelpTarget = async (
  token: string,
  catalog: PluginCommandCatalog = createPluginCommandCatalog(),
  signal?: AbortSignal,
): Promise<void> => {
  if (isHelpTopic(token)) return printTopicHelp(token, catalog);
  const helpCommand = resolveBuiltInCommand(token);
  if (helpCommand?.spec.id === token) return printCommandHelp(helpCommand);
  const resolutionExit = await Effect.runPromiseExit(
    interruptOnAbort(Effect.result(resolveToolingRoute(token)), signal),
  );
  if (Exit.isFailure(resolutionExit)) throw resolutionExit.cause;
  const resolution = resolutionExit.value;
  switch (resolution._tag) {
    case "Failure":
      return renderAliasResolutionFailure(resolution.failure);
    case "Success": {
      const route = resolution.success;
      switch (route._tag) {
        case "tooling":
        case "bun-script":
          if (!route.disabled) return printToolingHelp({ ...route, id: route.commandId }, route.aliasPolicy);
          return renderPreCommandFailure({
            commandId: route.commandId,
            error: new ToolingDisabledError({
              message: `Tooling command ${escapeDiagnosticText(route.commandId)} is disabled.`,
              tool: route.name,
              source: { path: route.sourcePath ?? "<cached tooling>", task: route.name },
              remediation: "Enable this task in the app's tooling definition before running it.",
            }),
            rendererMode: activeRendererMode,
            resultFormat: activeResultFormat,
          });
        case "built-in":
          return printCommandHelp(route.entry);
        case "plugin":
          await tryPluginCommandHelp(route.token, catalog);
          return;
        case "cache-miss":
        case "unknown-tooling":
          if (route._tag === "unknown-tooling" || !token.startsWith("app:")) {
            if (await tryPluginCommandHelp(token, catalog)) return;
            if (await catalog.topic(token)) {
              if (isEnvelopeResultFormat(activeResultFormat)) return printHelpCatalogPage(catalog);
              await printPluginTopicHelp(token, catalog);
              return;
            }
          }
          return renderPreCommandFailure({
            commandId: route.commandId,
            error: toolingRouteError(route),
            rendererMode: activeRendererMode,
            resultFormat: activeResultFormat,
          });
        case "not-tooling":
          if (helpCommand !== undefined) return printCommandHelp(helpCommand);
          break;
        case "alias-disabled":
          return renderPreCommandFailure({
            commandId: "cli:unknown-command",
            error: unknownCommandError(token),
            rendererMode: activeRendererMode,
            resultFormat: activeResultFormat,
          });
        default:
          route satisfies never;
      }
      break;
    }
    default:
      resolution satisfies never;
  }
  if (await tryPluginCommandHelp(token, catalog)) return;
  if (await catalog.topic(token)) {
    if (isEnvelopeResultFormat(activeResultFormat)) return printHelpCatalogPage(catalog);
    await printPluginTopicHelp(token, catalog);
    return;
  }
  await renderPreCommandFailure({
    commandId: "cli:unknown-command",
    error: unknownCommandError(token, await catalog.unknownCommandRemediation(token)),
    rendererMode: activeRendererMode,
    resultFormat: activeResultFormat,
  });
};
