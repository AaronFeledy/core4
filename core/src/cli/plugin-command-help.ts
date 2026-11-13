import type { CliInvocationContext } from "../runtime/invocation-context";
import { renderPluginTopicHelp } from "./cold-path-output";
import { activeRendererMode, activeResultFormat, emitResultLine } from "./compiled-runtime";
import { landoFlagsForPolicy, specOwnerPolicy } from "./flag-claims";
import { isEnvelopeResultFormat } from "./format-flags";
import { commandHelpInput } from "./help-command-input";
import { typeableName } from "./help-names";
import { redactHelpText } from "./help-redaction";
import { shouldStyleHelp } from "./help-style";
import { printMachineHelpTarget } from "./help-target";
import type { PluginCommandCatalog, PluginCommandDiagnostic } from "./plugin-command-catalog";
import { pluginFlagDefinitions } from "./plugin-flag-definitions";
import { renderPluginOwnedCommandHelp } from "./plugin-owned-command-input";
import { renderPreCommandFailure } from "./spec/command-boundary";

const renderHelpFailure = (error: PluginCommandDiagnostic, context?: CliInvocationContext): Promise<void> =>
  renderPreCommandFailure({
    ...(context === undefined ? {} : { context }),
    commandId: "cli:help",
    error,
    rendererMode: activeRendererMode,
    resultFormat: activeResultFormat,
  });

export const tryPluginCommandHelp = async (
  token: string,
  catalog: PluginCommandCatalog,
): Promise<boolean> => {
  const row = await catalog.resolve(token);
  if (row === undefined) return false;
  if ("unavailable" in row) {
    // Unavailable discovery can only explain a colon-form token that no other command is spelled close to.
    if (!token.includes(":") || (await catalog.hasCloseSpelling([token]))) return false;
    await renderHelpFailure(row.unavailable, catalog.context);
    return true;
  }
  if (row.loadError !== undefined) {
    await renderHelpFailure(row.loadError, catalog.context);
    return true;
  }
  const spec = row.spec;
  if (spec === undefined) return false;
  const aliases = row.tokens?.filter((token) => token !== row.id) ?? [];
  const name = typeableName({ canonicalId: row.id, builtInAliases: aliases });
  if (isEnvelopeResultFormat(activeResultFormat)) {
    await printMachineHelpTarget(
      {
        canonicalId: row.id,
        typeable: name.primary,
        extras: name.extras,
        summary: row.summary,
        source: "plugin",
        plugin: row.pluginName,
        provenance: row.source,
        implementation: "validated",
        input: commandHelpInput(spec, pluginFlagDefinitions(spec)),
        landoFlags: landoFlagsForPolicy(specOwnerPolicy(spec, pluginFlagDefinitions(spec))),
      },
      activeResultFormat,
      catalog.context,
    );
  } else {
    await emitResultLine(
      await redactHelpText(
        renderPluginOwnedCommandHelp(spec, {
          aliases,
          styled: shouldStyleHelp({
            isTTY: catalog.context?.io.stdoutIsTTY === true,
            env: catalog.context?.env ?? process.env,
            rendererMode: activeRendererMode,
          }),
        }),
        catalog.context,
      ),
      catalog.context,
    );
  }
  return true;
};

export const pluginHelpRows = (rows: Awaited<ReturnType<PluginCommandCatalog["list"]>>["rows"]) =>
  rows
    .filter((row) => row.descriptor.hidden !== true)
    .map((row) => ({
      canonicalId: row.id,
      ...typeableName({
        canonicalId: row.id,
        builtInAliases: row.tokens?.filter((token) => token !== row.id) ?? [],
      }),
      summary: row.summary,
    }));

export const printPluginTopicHelp = async (
  token: string,
  catalog: PluginCommandCatalog,
): Promise<boolean> => {
  const topic = await catalog.topic(token);
  if (topic === undefined) return false;
  const listing = await catalog.list(token);
  await emitResultLine(
    await redactHelpText(
      renderPluginTopicHelp(token, topic.description, pluginHelpRows(listing.rows), {
        style: shouldStyleHelp({
          isTTY: catalog.context?.io.stdoutIsTTY === true,
          env: catalog.context?.env ?? process.env,
          rendererMode: activeRendererMode,
        }),
      }),
      catalog.context,
    ),
    catalog.context,
  );
  return true;
};
