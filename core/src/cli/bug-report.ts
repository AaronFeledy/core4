import { resolveUserCacheRoot } from "@lando/engine/cache/paths";
import { escapeDiagnosticText } from "./diagnostic-text";
import { redactDetails, redactString } from "./redact";

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
  if (tag === "UpdateLaunchProbeError") {
    for (const key of [
      "platform",
      "attemptedVersion",
      "probeCommand",
      "outputSummary",
      "rollbackFailure",
    ] as const) {
      const value = asString(record[key]);
      if (value !== undefined) out.push([key, value]);
    }
    const exitCode = record.exitCode;
    if (typeof exitCode === "number") out.push(["exitCode", String(exitCode)]);
  }
  if (tag === "ServiceStartError" || tag === "ServiceExecError" || tag === "ServiceNotFoundError") {
    const service = asString(record.service);
    if (service !== undefined) out.push(["service", service]);
  }
  if (tag === "CapabilityError") {
    for (const field of ["service", "key", "capability"] as const) {
      const value = asString(record[field]);
      if (value !== undefined) out.push([field, value]);
    }
  }
  if (tag === "LandofileEventStepFailedError") {
    const event = asString(record.event);
    if (event !== undefined) out.push(["event", event]);
    const index = record.index;
    if (typeof index === "number") out.push(["step", String(index + 1)]);
    const kind = asString(record.kind);
    if (kind !== undefined) out.push(["kind", kind]);
    const service = asString(record.service);
    if (service !== undefined) out.push(["service", service]);
    const outputTail = asString(record.outputTail);
    if (outputTail !== undefined) out.push(["outputTail", outputTail]);
  }
  if (tag === "ComposeKeyRejectedError") {
    for (const field of ["source", "service", "keyPath"] as const) {
      const value = asString(record[field]);
      if (value !== undefined) out.push([field, value]);
    }
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

const extractCauseRecord = (
  record: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  // Only tagged Lando errors are safe to surface: raw Error.cause values can
  // carry OS paths with usernames (e.g. C:\Users\Alice\lando.exe).
  const cause = record === undefined ? undefined : asTaggedRecord(record.cause);
  return cause !== undefined && asString(cause._tag) !== undefined ? cause : undefined;
};

const mergeExtraFields = (
  primary: ReadonlyArray<readonly [string, string]>,
  nested: ReadonlyArray<readonly [string, string]>,
): ReadonlyArray<readonly [string, string]> => {
  const seen = new Set(primary.map(([key]) => key));
  const out: Array<readonly [string, string]> = [...primary];
  for (const pair of nested) {
    if (seen.has(pair[0])) continue;
    seen.add(pair[0]);
    out.push(pair);
  }
  return out;
};

const logsDirFor = (cacheRoot: string): string => `${cacheRoot.replace(/\/+$/u, "")}/logs`;

export const buildBugReport = (input: {
  readonly error: unknown;
  readonly context: BugReportContext;
}): BugReportEnvelope => {
  const record = asTaggedRecord(input.error);
  const causeRecord = extractCauseRecord(record);
  const ctx = input.context;
  const cacheDir = ctx.cacheRoot ?? resolveUserCacheRoot();
  const wrapperBody = extractMessage(record, input.error);
  const causeMessage = asString(causeRecord?.message);
  const bodyRaw =
    causeMessage !== undefined && causeMessage !== wrapperBody
      ? `${wrapperBody}\n${causeMessage}`
      : wrapperBody;
  const remediationRaw = REDACTED_REMEDIATION_FALLBACK(record) ?? REDACTED_REMEDIATION_FALLBACK(causeRecord);
  const code = extractCode(record);
  const appId = ctx.appId ?? extractAppId(record);
  const providerId = ctx.providerId ?? extractProviderId(record) ?? extractProviderId(causeRecord);
  const causeTag = asString(causeRecord?._tag);
  const extra = mergeExtraFields(
    [...(causeTag === undefined ? [] : ([["cause", causeTag]] as const)), ...extractExtraTagFields(record)],
    extractExtraTagFields(causeRecord),
  ).map(([key, value]) => {
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
  const renderText =
    envelope.code === "ComposeKeyRejectedError" ? escapeDiagnosticText : (text: string) => text;
  const lines: Array<string> = [renderText(envelope.body)];
  if (envelope.remediation !== undefined) {
    lines.push(`  ↳ ${renderText(envelope.remediation)}`);
  }
  const details: Array<string> = [
    `code: ${envelope.code}`,
    `commandId: ${escapeDiagnosticText(envelope.commandId)}`,
  ];
  if (envelope.appId !== undefined) details.push(`appId: ${envelope.appId}`);
  if (envelope.providerId !== undefined) details.push(`providerId: ${envelope.providerId}`);
  for (const [key, value] of envelope.extra) {
    details.push(`${key}: ${renderText(value)}`);
  }
  details.push(`logsDir: ${envelope.logsDir}`);
  details.push(`cacheDir: ${envelope.cacheDir}`);
  lines.push(...details);
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
