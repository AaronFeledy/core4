import { RendererSelectionError } from "@lando/sdk/errors";
import type { CliInvocationContext } from "../runtime/invocation-context";
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
 * How to serialize a refused output selection: a format we cannot emit, or
 * JSON controls that conflict with the format. Under `--format=ndjson`,
 * the refusal is a stream result frame. For other machine requests
 * (`--renderer=json`, `--json`, `--jq`) the refusal is a JSON envelope.
 * Human requests get the plain diagnostic.
 */
export const refusalOutputMode = (
  requested: ResultFormat,
): { readonly rendererMode: "json" | "plain"; readonly resultFormat: ResultFormat } => {
  if (requested === "ndjson") return { rendererMode: "json", resultFormat: "ndjson" };
  if (activeRendererMode === "json" || activeJsonControl.mode !== "off" || activeJq !== undefined)
    return { rendererMode: "json", resultFormat: "json" };
  return { rendererMode: "plain", resultFormat: "text" };
};

/**
 * Refuses a `--format` value the resolved command does not implement, naming
 * the formats it does. Must run before any surface that can succeed for the
 * requested command — notably `--json` key listing — or an unsupported format
 * still exits 0. Returns true when the run was refused and the caller must stop.
 */
export const rejectUnsupportedResultFormat = async (
  commandId: string,
  command: ResultFormatCapability | undefined,
  options: {
    readonly payloadStdout?: boolean;
    readonly context?: CliInvocationContext;
    /** Ownership guidance appended after the allowed-value remediation. */
    readonly remediationSuffix?: string;
  } = {},
): Promise<boolean> => {
  if (supportsResultFormat(command, activeResultFormat)) return false;
  const refusal = unsupportedResultFormatError({
    commandId,
    value: activeResultFormat,
    supported: commandResultFormats(command),
  });
  await renderPreCommandFailure({
    ...(options.context === undefined ? {} : { context: options.context }),
    commandId,
    error:
      options.remediationSuffix === undefined
        ? refusal
        : new RendererSelectionError({
            message: refusal.message,
            value: refusal.value,
            source: refusal.source,
            remediation: `${refusal.remediation} ${options.remediationSuffix}`,
          }),
    ...refusalOutputMode(activeResultFormat),
    ...(options.payloadStdout === true ? { payloadStdout: true } : {}),
    usage: true,
  });
  return true;
};
