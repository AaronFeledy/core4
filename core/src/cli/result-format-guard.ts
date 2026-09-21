import { activeJq, activeJsonControl, activeRendererMode, activeResultFormat } from "./compiled-runtime";
import {
  type ResultFormat,
  type ResultFormatCapability,
  commandResultFormats,
  supportsResultFormat,
  unsupportedResultFormatError,
} from "./format-flags";
import { renderPreCommandFailure } from "./spec/command-boundary";

/**
 * How to serialize the refusal of a format we cannot emit. The requested
 * format is by definition unusable, so the refusal is carried by whichever
 * surface the caller already asked for: `ndjson` is a machine request and gets
 * the JSON envelope, and so does any run that also passed `--renderer=json`,
 * `--json`, or `--jq`. Everything else is a human asking for a human rendering
 * and gets the plain diagnostic.
 */
const refusalOutputMode = (
  requested: ResultFormat,
): { readonly rendererMode: "json" | "plain"; readonly resultFormat: ResultFormat } =>
  requested === "ndjson" ||
  activeRendererMode === "json" ||
  activeJsonControl.mode !== "off" ||
  activeJq !== undefined
    ? { rendererMode: "json", resultFormat: "json" }
    : { rendererMode: "plain", resultFormat: "text" };

/**
 * Refuses a `--format` value the resolved command does not implement, naming
 * the formats it does. Must run before any surface that can succeed for the
 * requested command — notably `--json` key listing — or an unsupported format
 * still exits 0. Returns true when the run was refused and the caller must stop.
 */
export const rejectUnsupportedResultFormat = async (
  commandId: string,
  command: ResultFormatCapability | undefined,
): Promise<boolean> => {
  if (supportsResultFormat(command, activeResultFormat)) return false;
  await renderPreCommandFailure({
    commandId,
    error: unsupportedResultFormatError({
      commandId,
      value: activeResultFormat,
      supported: commandResultFormats(command),
    }),
    ...refusalOutputMode(activeResultFormat),
    failureExitCode: 2,
  });
  return true;
};
