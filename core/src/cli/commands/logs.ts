/** `lando logs` result rendering. */
import type { LogsAppResult } from "../../operations/logs.ts";

export const renderLogsAppResult = (result: LogsAppResult): string => {
  if (result.lines.length === 0) return `${result.app} (no log lines)`;
  return result.lines
    .map((line) =>
      line.source === undefined
        ? `${line.service} ${line.stream}: ${line.line}`
        : `${line.service} ${line.stream} [${line.source}]: ${line.line}`,
    )
    .join("\n");
};
