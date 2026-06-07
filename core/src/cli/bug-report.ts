/**
 * Standardized failure-output formatter for CLI commands.
 *
 * Every command failure becomes a bug-report block with a machine-readable
 * error code, the running command id, optional app/provider ids, and
 * pointers to the user cache and logs directories. Sensitive env-style
 * values (`*_TOKEN=`, `*_PASSWORD=`, etc.) and credential-named object
 * fields on `error.details` are redacted before anything reaches stderr.
 *
 * Two output modes are supported and selected by the renderer flag:
 *   - `plain` / `lando`: multi-line block; `body` first, then optional
 *     `↳ remediation`, then `key: value` diagnostic lines.
 *   - `json`: a single NDJSON line with `_tag: "message.error"` plus
 *     diagnostic fields; same shape that the renderer Layer would emit
 *     if `message.error` were published through `EventService`.
 *
 * Both source OCLIF (`LandoCommandBase.runEffect`) and the compiled
 * `$bunfs` dispatcher (`runCompiledCli` in `core/src/cli/run.ts`) call
 * `formatBugReport` so output stays bit-identical across the two paths.
 */

import { resolveUserCacheRoot } from "../cache/paths.ts";
import { redactDetails, redactString } from "./redact.ts";

export type RendererMode = "lando" | "plain" | "json" | "verbose";

export interface BugReportContext {
  readonly commandId: string;
  readonly appId?: string;
  readonly providerId?: string;
  readonly cacheRoot?: string;
}

export interface BugReportEnvelope {
  readonly code: string;
  readonly commandId: string;
  readonly body: string;
  readonly remediation: string | undefined;
  readonly appId: string | undefined;
  readonly providerId: string | undefined;
  readonly logsDir: string;
  readonly cacheDir: string;
  readonly extra: ReadonlyArray<readonly [string, string]>;
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asTaggedRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
};

const extractCode = (record: Record<string, unknown> | undefined): string => {
  if (record === undefined) return "Error";
  const tag = asString(record._tag);
  if (tag !== undefined) return tag;
  const name = asString(record.name);
  if (name !== undefined) return name;
  return "Error";
};

const appIdReservedMessage = (record: Record<string, unknown>): string => {
  const reserved = asString(record.reserved) ?? "global";
  return `The app id "${reserved}" is reserved for the global Lando app and cannot be used as a project name.`;
};

const extractMessage = (record: Record<string, unknown> | undefined, error: unknown): string => {
  if (record !== undefined) {
    if (asString(record._tag) === "AppIdReservedError") return appIdReservedMessage(record);
    const message = asString(record.message);
    if (message !== undefined) return message;
  }
  return String(error);
};

const extractAppId = (record: Record<string, unknown> | undefined): string | undefined => {
  if (record === undefined) return undefined;
  const direct = asString(record.appId);
  if (direct !== undefined) return direct;
  const appName = asString(record.appName);
  if (appName !== undefined) return appName;
  const app = asTaggedRecord(record.app);
  if (app !== undefined) {
    const id = asString(app.id);
    if (id !== undefined) return id;
    const name = asString(app.name);
    if (name !== undefined) return name;
  }
  return undefined;
};

const extractProviderId = (record: Record<string, unknown> | undefined): string | undefined => {
  if (record === undefined) return undefined;
  return asString(record.providerId) ?? asString(record.provider);
};

const extractExtraTagFields = (
  record: Record<string, unknown> | undefined,
): ReadonlyArray<readonly [string, string]> => {
  if (record === undefined) return [];
  const out: Array<[string, string]> = [];
  const tag = asString(record._tag);
  if (tag === "LandofileParseError") {
    const filePath = asString(record.filePath);
    if (filePath !== undefined) out.push(["filePath", filePath]);
    const line = record.line;
    if (typeof line === "number") out.push(["line", String(line)]);
  }
  if (tag === "AppIdReservedError") {
    const reserved = asString(record.reserved);
    if (reserved !== undefined) out.push(["reserved", reserved]);
    const suggested = asString(record.suggested);
    if (suggested !== undefined) out.push(["suggested", suggested]);
  }
  if (tag === "RendererSelectionError") {
    const value = asString(record.value);
    if (value !== undefined) out.push(["value", value]);
    const source = asString(record.source);
    if (source !== undefined) out.push(["source", source]);
  }
  if (tag === "RecipePromptValidationError") {
    const promptName = asString(record.promptName);
    if (promptName !== undefined) out.push(["promptName", promptName]);
  }
  if (tag === "ServiceStartError" || tag === "ServiceExecError" || tag === "ServiceNotFoundError") {
    const service = asString(record.service);
    if (service !== undefined) out.push(["service", service]);
  }
  if (tag === "RecipePostInitError") {
    const recipe = asString(record.recipe);
    if (recipe !== undefined) out.push(["recipe", recipe]);
    const exitCode = record.exitCode;
    if (typeof exitCode === "number") out.push(["exitCode", String(exitCode)]);
  }
  if (tag === "RecipeManifestValidationError" || tag === "LandofileValidationError") {
    const issues = record.issues;
    if (Array.isArray(issues) && issues.length > 0) {
      const flat = issues
        .filter((issue): issue is string => typeof issue === "string")
        .map((issue) => `- ${issue}`)
        .join("\n");
      if (flat.length > 0) out.push(["issues", `\n${flat}`]);
    }
  }
  const op = asString(record.operation);
  if (op !== undefined) out.push(["operation", op]);
  return out;
};

const landofileNotFoundHint = (record: Record<string, unknown> | undefined): string | undefined =>
  asString(record?._tag) === "LandofileNotFoundError"
    ? "Run `lando init --full --name=<name>` to scaffold an app."
    : undefined;

const appIdReservedHint = (record: Record<string, unknown> | undefined): string | undefined => {
  if (asString(record?._tag) !== "AppIdReservedError") return undefined;
  const suggested = asString(record?.suggested);
  return suggested !== undefined
    ? `Rename the project in your Landofile, e.g. name: ${suggested}.`
    : 'Choose a different project name in your Landofile; "global" is reserved.';
};

const REDACTED_REMEDIATION_FALLBACK = (record: Record<string, unknown> | undefined): string | undefined => {
  const remediation = asString(record?.remediation);
  if (remediation !== undefined) return remediation;
  return landofileNotFoundHint(record) ?? appIdReservedHint(record);
};

const logsDirFor = (cacheRoot: string): string => `${cacheRoot.replace(/\/+$/u, "")}/logs`;

export const buildBugReport = (input: {
  readonly error: unknown;
  readonly context: BugReportContext;
}): BugReportEnvelope => {
  const record = asTaggedRecord(input.error);
  const ctx = input.context;
  const cacheDir = ctx.cacheRoot ?? resolveUserCacheRoot();
  const bodyRaw = extractMessage(record, input.error);
  const remediationRaw = REDACTED_REMEDIATION_FALLBACK(record);
  const code = extractCode(record);
  const appId = ctx.appId ?? extractAppId(record);
  const providerId = ctx.providerId ?? extractProviderId(record);
  const extra = extractExtraTagFields(record).map(([key, value]) => {
    const sanitized = key === "issues" ? value : redactString(value);
    return [key, sanitized] as readonly [string, string];
  });

  return {
    code,
    commandId: ctx.commandId,
    body: redactString(bodyRaw),
    remediation: remediationRaw === undefined ? undefined : redactString(remediationRaw),
    appId,
    providerId,
    logsDir: logsDirFor(cacheDir),
    cacheDir,
    extra,
  };
};

export const renderPlainBugReport = (envelope: BugReportEnvelope): string => {
  const lines: Array<string> = [envelope.body];
  if (envelope.remediation !== undefined) {
    lines.push(`  ↳ ${envelope.remediation}`);
  }
  lines.push(`code: ${envelope.code}`);
  lines.push(`commandId: ${envelope.commandId}`);
  if (envelope.appId !== undefined) lines.push(`appId: ${envelope.appId}`);
  if (envelope.providerId !== undefined) lines.push(`providerId: ${envelope.providerId}`);
  for (const [key, value] of envelope.extra) {
    lines.push(`${key}: ${value}`);
  }
  lines.push(`logsDir: ${envelope.logsDir}`);
  lines.push(`cacheDir: ${envelope.cacheDir}`);
  return lines.join("\n");
};

const orderedJsonKeys: ReadonlyArray<keyof BugReportEnvelope | "_tag"> = [
  "_tag",
  "code",
  "commandId",
  "appId",
  "providerId",
  "body",
  "remediation",
  "logsDir",
  "cacheDir",
];

export const renderJsonBugReport = (envelope: BugReportEnvelope): string => {
  const record: Record<string, unknown> = { _tag: "message.error" };
  record.code = envelope.code;
  record.commandId = envelope.commandId;
  if (envelope.appId !== undefined) record.appId = envelope.appId;
  if (envelope.providerId !== undefined) record.providerId = envelope.providerId;
  record.body = envelope.body;
  if (envelope.remediation !== undefined) record.remediation = envelope.remediation;
  record.logsDir = envelope.logsDir;
  record.cacheDir = envelope.cacheDir;
  for (const [key, value] of envelope.extra) {
    if (key !== "issues") record[key] = value;
  }
  record.timestamp = new Date().toISOString();

  const ordered: Record<string, unknown> = {};
  for (const key of orderedJsonKeys) {
    if (Object.hasOwn(record, key)) ordered[key as string] = record[key as string];
  }
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(ordered, key)) ordered[key] = record[key];
  }
  return JSON.stringify(ordered);
};

export const formatBugReport = (input: {
  readonly error: unknown;
  readonly context: BugReportContext;
  readonly rendererMode: RendererMode;
}): string => {
  const envelope = buildBugReport({ error: input.error, context: input.context });
  if (input.rendererMode === "json") return renderJsonBugReport(envelope);
  return renderPlainBugReport(envelope);
};

export const redactedErrorDetails = redactDetails;
