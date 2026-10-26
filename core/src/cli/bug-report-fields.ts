import type { TaggedErrorJson } from "@lando/sdk/schema";
import { formatStructuredIssue } from "./validation-issue-text";

const consumed = new Set([
  "_tag",
  "message",
  "remediation",
  "appId",
  "appName",
  "app",
  "providerId",
  "provider",
  "additionalErrors",
  "role",
  "commandId",
  "code",
  "body",
  "logsDir",
  "cacheDir",
  "timestamp",
]);

const scalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

const logTailField = (value: unknown): readonly [string, string] | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const lines = Reflect.get(value, "lines");
  if (!Array.isArray(lines) || lines.length === 0) return undefined;
  const text = lines.filter((line): line is string => typeof line === "string").join("\n");
  if (text.length === 0) return undefined;
  const parts: string[] = [];
  const service = Reflect.get(value, "service");
  if (typeof service === "string" && service.length > 0) parts.push(service);
  const exitCode = Reflect.get(value, "exitCode");
  if (typeof exitCode === "number" && Number.isFinite(exitCode)) parts.push(`exit ${exitCode}`);
  if (Reflect.get(value, "timedOut") === true) parts.push("timed out");
  if (Reflect.get(value, "truncated") === true) parts.push("truncated");
  return [parts.length === 0 ? "logTail" : `logTail (${parts.join(", ")})`, text];
};

export const diagnosticFields = (
  error: typeof TaggedErrorJson.Type,
): ReadonlyArray<readonly [string, string]> => {
  const out: Array<readonly [string, string]> = [];
  for (const [key, value] of Object.entries(error)) {
    if (consumed.has(key) || value === "") continue;
    if (key === "step" && typeof error.index === "number") continue;
    if (key === "index" && typeof error.step === "number") {
      out.push(["step", String(error.step)]);
      continue;
    }
    if (key === "issues") {
      const text = error.issues
        ?.flatMap((issue) => {
          const line = formatStructuredIssue(issue);
          return line === undefined ? [] : [line];
        })
        .join("\n");
      if (text) out.push([key, `\n${text}`]);
    } else if (key === "logTail") {
      const tail = logTailField(value);
      if (tail !== undefined) out.push(tail);
    } else if (key === "outputTail" && typeof value === "string") {
      out.push([key, value]);
    } else if (scalar(value)) out.push([key, String(value)]);
    else if (Array.isArray(value) && value.every(scalar)) out.push([key, value.join(", ")]);
  }
  return out;
};
