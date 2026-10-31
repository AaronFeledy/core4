import { renderPluginTopicHelp } from "./cold-path-output";
import { activeRendererMode, activeResultFormat, emitResultLine } from "./compiled-runtime";
import { isEnvelopeResultFormat } from "./format-flags";
import { redactHelpText } from "./help-redaction";
import { shouldStyleHelp } from "./help-style";
import { printMachineHelpTarget } from "./help-target";
import type { PluginCommandCatalog, PluginCommandDiagnostic } from "./plugin-command-catalog";
import { renderPluginOwnedCommandHelp } from "./plugin-owned-command-input";
import { renderPreCommandFailure } from "./spec/command-boundary";

const renderHelpFailure = (error: PluginCommandDiagnostic): Promise<void> =>
  renderPreCommandFailure({
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
    // Unavailable discovery can only explain a colon-form token; a bare token may still be a topic or typo.
    if (!token.includes(":")) return false;
    await renderHelpFailure(row.unavailable);
    return true;
  }
  if (row.loadError !== undefined) {
    await renderHelpFailure(row.loadError);
    return true;
  }
  if (isEnvelopeResultFormat(activeResultFormat)) {
    await printMachineHelpTarget(
      {
        canonicalId: row.id,
        typeable: row.id,
        extras: [],
        summary: row.summary,
        source: "plugin",
        plugin: row.pluginName,
      },
      activeResultFormat,
    );
  } else if (row.spec !== undefined) {
    await emitResultLine(
      await redactHelpText(
        renderPluginOwnedCommandHelp(row.spec, {
          styled: shouldStyleHelp({
            isTTY: process.stdout.isTTY === true,
            env: process.env,
            argv: process.argv.slice(2),
            rendererMode: activeRendererMode,
          }),
        }),
      ),
    );
  }
  return true;
};

export const pluginHelpRows = (rows: Awaited<ReturnType<PluginCommandCatalog["list"]>>["rows"]) =>
  rows.map((row) => ({ canonicalId: row.id, primary: row.id, extras: [], summary: row.summary }));

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
          isTTY: process.stdout.isTTY === true,
          env: process.env,
          argv: process.argv.slice(2),
          rendererMode: activeRendererMode,
        }),
      }),
    ),
  );
  return true;
};
