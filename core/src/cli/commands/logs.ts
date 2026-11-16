/** `lando logs` result rendering. */
import type { LogsAppResult } from "@lando/engine/operations/logs";

export const renderLogsAppResult = (result: LogsAppResult, buildOutput = false): string => {
  if (result.lines === undefined) return "";
  if (result.lines.length === 0) {
    if (buildOutput) {
      return `${result.app} has no recorded build output.`;
    }
    return `${result.app} (no log lines)`;
  }
  return result.lines
    .map((line) =>
      line.source === undefined
        ? `${line.service} ${line.stream}: ${line.line}`
        : `${line.service} ${line.stream} [${line.source}]: ${line.line}`,
    )
    .join("\n");
};
