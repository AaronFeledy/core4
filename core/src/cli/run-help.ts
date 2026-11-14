import { ToolingDisabledError } from "@lando/sdk/errors";
import { Effect, Exit, Layer } from "effect";
import {
  CliInvocation,
  type CliInvocationContext,
  processInvocationDefaults,
} from "../runtime/invocation-context";
import { resolveBuiltInCommand } from "./built-in-command-registry";
import {
  type HelpTopic,
  isHelpTopic,
  renderColdAllHelp,
  renderColdRootHelp,
  renderColdTopicHelp,
} from "./cold-path-output";
import {
  pluginRowsForCache,
  printCommandHelp,
  printHelpCatalogJson,
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
import { shouldStyleHelp } from "./help-style";
import { interruptOnAbort } from "./interrupt-on-abort";
import { type PluginCommandCatalog, createPluginCommandCatalog } from "./plugin-command-catalog";
import { pluginHelpRows, printPluginTopicHelp, tryPluginCommandHelp } from "./plugin-command-help";
import { renderPreCommandFailure } from "./spec/command-boundary";
import { toolingMetadataStatus } from "./tooling-cache-status";
import { readCliAppCommandCache } from "./tooling-command-cache";
import { resolveToolingRoute, toolingRouteFailure, unavailableScriptError } from "./tooling-router";
import { unknownCommandError } from "./unknown-command-error";

const readHelpCache = async (context?: CliInvocationContext) => {
  const operation = Effect.result(readCliAppCommandCache({ includeScriptInventory: true }));
  const exit = await Effect.runPromiseExit(
    context === undefined ? operation : operation.pipe(Effect.provideService(CliInvocation, context)),
  );
  if (Exit.isFailure(exit)) throw exit.cause;
  const result = exit.value;
  switch (result._tag) {
    case "Failure":
      await renderAliasResolutionFailure(result.failure, context);
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

const pluginConflictNotice = (diagnostics: readonly { readonly message: string }[]): string => {
  const shown = diagnostics.slice(0, 3).map((diagnostic) => `  ${diagnostic.message}`);
  const more = diagnostics.length - shown.length;
  return [
    "Plugin command conflicts:",
    ...shown,
    ...(more > 0 ? [`  ...and ${more} more. Run \`lando help --format=json\` for details.`] : []),
  ].join("\n");
};

const coldHelpStyle = (catalog: PluginCommandCatalog) => ({
  style: shouldStyleHelp({
    isTTY: catalog.context?.io.stdoutIsTTY === true,
    env: catalog.context?.env ?? {},
    rendererMode: activeRendererMode,
  }),
});

export const printAllHelp = async (
  catalog: PluginCommandCatalog = createPluginCommandCatalog(),
): Promise<void> => {
  if (isEnvelopeResultFormat(activeResultFormat)) return printHelpCatalogPage(catalog);
  const result = await readHelpCache(catalog.context);
  if (result === undefined) return;
  const { cache, toolingMetadata } = result;
  const plugins = await catalog.list();
  await emitResultLine(
    await redactHelpText(
      renderColdAllHelp({
        ...coldHelpStyle(catalog),
        thisAppRows: cache === null ? [] : thisAppHelpRowsFromCache(cache),
        toolingMetadata,
        pluginRows: pluginHelpRows(pluginRowsForCache(plugins.rows, cache)),
        ...(plugins.metadata.status === "unavailable"
          ? {
              pluginNotice: `Plugin commands unavailable: ${plugins.metadata.message} ${plugins.metadata.remediation ?? ""}`,
            }
          : (plugins.metadata.diagnostics?.length ?? 0) > 0
            ? { pluginNotice: pluginConflictNotice(plugins.metadata.diagnostics ?? []) }
            : {}),
        ...(cache?.aliasPolicy === undefined ? {} : { aliasPolicy: cache.aliasPolicy }),
      }),
      catalog.context,
    ),
    catalog.context,
  );
};

const printTopicHelp = async (topic: HelpTopic, catalog: PluginCommandCatalog): Promise<void> => {
  if (isEnvelopeResultFormat(activeResultFormat)) return printHelpCatalogPage(catalog);
  const result = await readHelpCache(catalog.context);
  if (result === undefined) return;
  const { cache } = result;
  await emitResultLine(
    renderColdTopicHelp(topic, {
      ...coldHelpStyle(catalog),
      ...(cache?.aliasPolicy === undefined ? {} : { aliasPolicy: cache.aliasPolicy }),
    }),
    catalog.context,
  );
};

export const rejectUnknownHelpFlags = async (
  argv: ReadonlyArray<string>,
  context?: CliInvocationContext,
): Promise<boolean> => {
  const flagError = validateCommandCliFlags({
    commandId: "cli:help",
    argv,
    definitions: { all: { type: "boolean" }, help: { type: "boolean", char: "h" } },
    allowUnknownFlags: false,
  });
  if (flagError === undefined) return false;
  await runCompiledCommand(Effect.fail(flagError), Layer.empty, () => undefined, {
    ...(context === undefined ? {} : { context }),
    preCommand: true,
    usage: true,
  });
  return true;
};

export const printRootHelpPage = async (
  catalog: PluginCommandCatalog = createPluginCommandCatalog(),
): Promise<void> => {
  if (isEnvelopeResultFormat(activeResultFormat)) return printHelpCatalogPage(catalog);
  const result = await readHelpCache(catalog.context);
  if (result === undefined) return;
  const { cache, toolingMetadata } = result;
  const plugins = await catalog.list();
  await emitResultLine(
    await redactHelpText(
      renderColdRootHelp(undefined, {
        ...coldHelpStyle(catalog),
        thisAppRows: cache === null ? [] : thisAppHelpRowsFromCache(cache),
        toolingMetadata,
        ...(plugins.topics === undefined ? {} : { pluginTopics: plugins.topics }),
        ...(cache?.aliasPolicy === undefined ? {} : { aliasPolicy: cache.aliasPolicy }),
      }),
      catalog.context,
    ),
    catalog.context,
  );
};

export const printHelpCatalogPage = async (
  catalog: PluginCommandCatalog = createPluginCommandCatalog(),
): Promise<void> => {
  const result = await readHelpCache(catalog.context);
  if (result === undefined) return;
  await printHelpCatalogJson(
    result.cache,
    isEnvelopeResultFormat(activeResultFormat) ? activeResultFormat : "json",
    result.toolingMetadata,
    await catalog.list(),
    catalog.context,
  );
};

export const dispatchHelpTarget = async (
  token: string,
  catalog: PluginCommandCatalog = createPluginCommandCatalog(),
  signal?: AbortSignal,
): Promise<void> => {
  if (isHelpTopic(token)) return printTopicHelp(token, catalog);
  const helpCommand = resolveBuiltInCommand(token);
  if (helpCommand?.spec.id === token) return printCommandHelp(helpCommand, catalog.context);
  const resolutionExit = await Effect.runPromiseExit(
    interruptOnAbort(Effect.result(resolveToolingRoute(token, { catalog })), signal).pipe(
      Effect.provideService(CliInvocation, catalog.context ?? processInvocationDefaults),
    ),
  );
  if (Exit.isFailure(resolutionExit)) throw resolutionExit.cause;
  const resolution = resolutionExit.value;
  switch (resolution._tag) {
    case "Failure":
      return renderAliasResolutionFailure(resolution.failure, catalog.context);
    case "Success": {
      const route = resolution.success;
      switch (route._tag) {
        case "tooling":
        case "bun-script": {
          const unavailable = await Effect.runPromise(unavailableScriptError(route));
          if (unavailable !== undefined && !route.disabled)
            return renderAliasResolutionFailure(unavailable, catalog.context, route.commandId);
          if (!route.disabled)
            return printToolingHelp(
              {
                ...route,
                id: route.commandId,
                ...(route._tag === "bun-script" ? { source: route._tag } : {}),
              },
              route.aliasPolicy,
              catalog.context,
            );
          return renderPreCommandFailure({
            ...(catalog.context === undefined ? {} : { context: catalog.context }),
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
        }
        case "built-in":
          return printCommandHelp(route.entry, catalog.context);
        case "plugin":
          await tryPluginCommandHelp(route.token, catalog);
          return;
        case "unknown-tooling":
          break;
        case "cache-miss":
          if (!token.startsWith("app:")) {
            if (await tryPluginCommandHelp(token, catalog)) return;
            if (await catalog.topic(token)) {
              if (isEnvelopeResultFormat(activeResultFormat)) return printHelpCatalogPage(catalog);
              await printPluginTopicHelp(token, catalog);
              return;
            }
          }
          return renderPreCommandFailure({
            ...(catalog.context === undefined ? {} : { context: catalog.context }),
            commandId: route.commandId,
            error: toolingRouteFailure(route),
            rendererMode: activeRendererMode,
            resultFormat: activeResultFormat,
          });
        case "not-tooling":
          if (helpCommand !== undefined) return printCommandHelp(helpCommand, catalog.context);
          break;
        case "alias-disabled":
          return renderPreCommandFailure({
            ...(catalog.context === undefined ? {} : { context: catalog.context }),
            commandId: "cli:unknown-command",
            error: unknownCommandError(token),
            rendererMode: activeRendererMode,
            resultFormat: activeResultFormat,
            usage: true,
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
    ...(catalog.context === undefined ? {} : { context: catalog.context }),
    commandId: "cli:unknown-command",
    error: unknownCommandError(token, await catalog.unknownCommandGuidance([token])),
    rendererMode: activeRendererMode,
    resultFormat: activeResultFormat,
    usage: true,
  });
};
