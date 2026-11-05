import { types } from "node:util";
import { resolveUserCacheRoot } from "@lando/engine/cache/paths";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { type ProjectedFailure, taggedErrorJson } from "@lando/sdk/command-result";
import { type FailureRole, ValidationIssue } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { Schema } from "effect";
import { diagnosticFields } from "./bug-report-fields";
import { renderJsonBugReport, renderPlainBugReport } from "./bug-report-render";
import { redactDetails } from "./redact";

export { renderJsonBugReport, renderPlainBugReport } from "./bug-report-render";
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
  readonly remediation: string;
  readonly appId: string | undefined;
  readonly providerId: string | undefined;
  readonly logsDir: string;
  readonly cacheDir: string;
  readonly issues?: ReadonlyArray<ValidationIssue>;
  /** Structured members of an aggregate error, redacted; the text renderer uses the `failures` extra instead. */
  readonly failures?: ReadonlyArray<unknown>;
  readonly extra: ReadonlyArray<readonly [string, string]>;
  readonly additionalErrors?: ReadonlyArray<{
    readonly role: FailureRole;
    readonly code: string;
    readonly body: string;
    readonly remediation: string;
    readonly issues?: ReadonlyArray<ValidationIssue>;
    readonly extra: ReadonlyArray<readonly [string, string]>;
  }>;
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const ownCause = (value: unknown): unknown => {
  if (value === null || typeof value !== "object" || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, "cause");
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
};

const mergeExtraFields = (
  primary: ReadonlyArray<readonly [string, string]>,
  nested: ReadonlyArray<readonly [string, string]>,
): ReadonlyArray<readonly [string, string]> => {
  const seen = new Set(primary.map(([key]) => key));
  return [
    ...primary,
    ...nested.filter(([key]) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
};

export const buildBugReport = (input: {
  readonly error: unknown;
  readonly additionalErrors?: ProjectedFailure["additionalErrors"];
  readonly context: BugReportContext;
  readonly redactor?: Redactor;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
}): BugReportEnvelope => {
  const redactor =
    input.redactor ??
    createStandaloneRedactor("secrets", {
      sourceEnv: { ...(input.sourceEnv ?? process.env) },
    });
  const error = taggedErrorJson(input.error);
  const causes: Array<ReturnType<typeof taggedErrorJson>> = [];
  const seen = new Set<unknown>([input.error]);
  let current = ownCause(input.error);
  for (let depth = 0; depth < 4 && current !== undefined && !seen.has(current); depth++) {
    if (current === null || typeof current !== "object" || types.isProxy(current)) break;
    const tag = Object.getOwnPropertyDescriptor(current, "_tag");
    if (tag === undefined || !("value" in tag) || typeof tag.value !== "string") break;
    seen.add(current);
    causes.push(taggedErrorJson(current));
    current = ownCause(current);
  }
  const ctx = input.context;
  const cacheDir = ctx.cacheRoot ?? resolveUserCacheRoot();
  const diagnostics = [error, ...causes];
  const app = error.app;
  const appId =
    ctx.appId ??
    asString(error.appId) ??
    asString(error.appName) ??
    (app !== null && typeof app === "object"
      ? (asString(Reflect.get(app, "id")) ?? asString(Reflect.get(app, "name")))
      : undefined);
  const providerId =
    ctx.providerId ??
    diagnostics
      .map((item) => asString(item.providerId) ?? asString(item.provider))
      .find((value) => value !== undefined);
  const causeFields = causes
    .toReversed()
    .reduce<ReadonlyArray<readonly [string, string]>>(
      (fields, cause) => mergeExtraFields(fields, diagnosticFields(cause)),
      [],
    );
  const deepest = causes.at(-1);
  const extra = mergeExtraFields(
    [...(deepest === undefined ? [] : [["cause", deepest._tag] as const]), ...causeFields],
    diagnosticFields(error),
  ).map(([key, value]) => [key, redactor.redactString(value)] as const);
  const issues = diagnostics.flatMap((item) => item.issues ?? []);
  const failures = Array.isArray(error.failures) ? redactor.redactValue(error.failures) : undefined;
  return {
    code: redactor.redactString(error._tag),
    commandId: ctx.commandId,
    body: redactor.redactString([...new Set(diagnostics.map((item) => item.message))].join("\n")),
    remediation: redactor.redactString([...new Set(diagnostics.map((item) => item.remediation))].join(" ")),
    appId,
    providerId,
    logsDir: `${cacheDir.replace(/\/+$/u, "")}/logs`,
    cacheDir,
    ...(issues.length === 0
      ? {}
      : { issues: Schema.decodeUnknownSync(Schema.Array(ValidationIssue))(redactor.redactValue(issues)) }),
    ...(Array.isArray(failures) && failures.length > 0 ? { failures } : {}),
    extra,
    ...(input.additionalErrors === undefined || input.additionalErrors.length === 0
      ? {}
      : {
          additionalErrors: input.additionalErrors.map(({ role, error: additionalError }) => {
            const additional = buildBugReport({
              ...input,
              redactor,
              error: additionalError,
              additionalErrors: [],
            });
            const identity = [
              ["appId", additional.appId, appId],
              ["providerId", additional.providerId, providerId],
            ] as const;
            return {
              role,
              code: additional.code,
              body: additional.body,
              remediation: additional.remediation,
              ...(additional.issues === undefined ? {} : { issues: additional.issues }),
              extra: [
                ...identity.flatMap(([key, value, primary]) =>
                  value === undefined || value === primary ? [] : [[key, value] as const],
                ),
                ...additional.extra.filter(
                  ([key, value]) =>
                    !extra.some(([primaryKey, primaryValue]) => primaryKey === key && primaryValue === value),
                ),
              ],
            };
          }),
        }),
  };
};

export const formatBugReport = (
  input: ProjectedFailure & {
    readonly context: BugReportContext;
    readonly rendererMode: RendererMode;
    readonly redactor?: Redactor;
    readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  },
): string => {
  const envelope = buildBugReport(input);
  return input.rendererMode === "json" ? renderJsonBugReport(envelope) : renderPlainBugReport(envelope);
};

export const redactedErrorDetails = redactDetails;
