import { LandofileEventStepFailedError, ToolingCompileError } from "@lando/sdk/errors";
import {
  type FailureRole,
  TaggedErrorJson,
  type ValidationIssue,
  type ValidationIssuePath,
  type ValidationIssueSource,
} from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { Schema } from "effect";
import { taggedErrorJson } from "./diagnostic.ts";
import { encodeRedactedJson } from "./redacted-json.ts";
import { redactValueWithPolicy, structuralRedaction } from "./structural-redaction.ts";

export type ToolingDiagnostic = Pick<
  ToolingCompileError,
  "_tag" | "tool" | "source" | "message" | "remediation" | "issues" | "omittedIssueCount" | "cause"
>;

const MAX_BYTES = 16 * 1024;
const MAX_SUMMARY_BYTES = 1024;
const MAX_ISSUES = 8;
const encoder = new TextEncoder();
const diagnosticPolicy = structuralRedaction(TaggedErrorJson);
const serializedBytes = (value: unknown, redactor: Pick<Redactor, "redactString">): number =>
  // The retained object and its final envelope can differ in either direction.
  Math.max(
    encoder.encode(JSON.stringify(value)).byteLength,
    encoder.encode(
      encodeRedactedJson(value, redactor, typeof value === "string" ? undefined : diagnosticPolicy),
    ).byteLength,
  );

export const boundedDiagnosticSummary = (
  redacted: string,
  redactor: Pick<Redactor, "redactString"> = { redactString: (text) => text },
): string => {
  if (serializedBytes(redacted, redactor) <= MAX_SUMMARY_BYTES) return redacted;
  const characters = Array.from(redacted);
  let end = characters.length;
  while (end > 0) {
    const candidate = `${characters.slice(0, end).join("")}...`;
    const bytes = serializedBytes(candidate, redactor);
    if (bytes <= MAX_SUMMARY_BYTES) return candidate;
    end -= Math.max(1, Math.ceil((bytes - MAX_SUMMARY_BYTES) / 6));
  }
  return "...";
};

/**
 * Disclose only this allowlisted contract, after binding all known secrets to the required redactor.
 * `maxBytes` narrows the 16 KiB aggregate bound for a carrier that wraps the diagnostic.
 */
export const projectToolingDiagnostic = (
  diagnostic: ToolingDiagnostic,
  redactor: Pick<Redactor, "redactString">,
  options: { readonly maxBytes?: number } = {},
): ToolingDiagnostic => {
  const maxBytes = Math.min(options.maxBytes ?? MAX_BYTES, MAX_BYTES);
  const text = (value: string) => redactor.redactString(value);
  const tool = text(diagnostic.tool);
  const identity = {
    _tag: diagnostic._tag,
    tool: serializedBytes(tool, redactor) <= MAX_SUMMARY_BYTES ? tool : "[omitted]",
  };
  const source =
    diagnostic.source === undefined
      ? {}
      : { source: { path: text(diagnostic.source.path), task: text(diagnostic.source.task) } };
  const summaries = projectSummaries(diagnostic, redactor);
  const withSource = { ...identity, ...source, ...summaries };
  return projectDetails(
    serializedBytes({ ...withSource, ...emptyDetails(diagnostic) }, redactor) <= maxBytes
      ? withSource
      : { ...identity, ...summaries },
    diagnostic,
    { redactor, maxBytes },
  );
};

type RefusalDetails = {
  readonly issues?: readonly ValidationIssue[] | undefined;
  readonly omittedIssueCount?: number | undefined;
  readonly cause?: unknown;
};

const emptyDetails = (
  input: RefusalDetails,
): {
  readonly issues: readonly ValidationIssue[];
  readonly omittedIssueCount: number;
} => ({
  issues: [],
  omittedIssueCount: (input.omittedIssueCount ?? 0) + (input.issues?.length ?? 0),
});

type RefusalSummary = { readonly message: string; readonly remediation: string };

const projectSummaries = (diagnostic: RefusalSummary, redactor: Pick<Redactor, "redactString">) => ({
  message: boundedDiagnosticSummary(redactor.redactString(diagnostic.message), redactor),
  remediation: boundedDiagnosticSummary(redactor.redactString(diagnostic.remediation), redactor),
});

const projectDetails = <A extends RefusalSummary>(
  base: A,
  diagnostic: RefusalDetails,
  { redactor, maxBytes }: { readonly redactor: Pick<Redactor, "redactString">; readonly maxBytes: number },
): A & ReturnType<typeof emptyDetails> & Pick<RefusalDetails, "cause"> => {
  const text = (value: string) => redactor.redactString(value);
  const path = (value: ValidationIssuePath) =>
    value.map((segment) => (typeof segment === "string" ? text(segment) : segment));
  const source = (value: ValidationIssueSource): ValidationIssueSource => {
    const location = { layer: value.layer, path: path(value.path) };
    switch (value.layer) {
      case "base":
      case "dist":
      case "upstream":
      case "canonical":
      case "local":
      case "user":
      case "config-file":
      case "config-drop-in":
      case "script":
      case "project-file":
        return { ...location, layer: value.layer, file: text(value.file) };
      case "env":
        return { ...location, layer: value.layer, variable: text(value.variable) };
      case "host":
      case "default":
        return { ...location, layer: value.layer };
      default:
        return value satisfies never;
    }
  };
  const location = (value: Pick<ValidationIssue, "path" | "source">) => ({
    path: path(value.path),
    ...(value.source === undefined ? {} : { source: source(value.source) }),
  });
  const issues = diagnostic.issues ?? [];
  let result = { ...base, ...emptyDetails(diagnostic) };
  for (const issue of issues) {
    if (result.issues.length === MAX_ISSUES) break;
    const sanitized: ValidationIssue = {
      ...location(issue),
      message: text(issue.message),
      ...(issue.rule === undefined ? {} : { rule: issue.rule }),
      ...(issue.kind === undefined ? {} : { kind: issue.kind }),
      ...(issue.reason === undefined ? {} : { reason: text(issue.reason) }),
      ...(issue.suggestion === undefined ? {} : { suggestion: text(issue.suggestion) }),
      ...(issue.related === undefined ? {} : { related: issue.related.map(location) }),
    };
    const candidate = {
      ...result,
      issues: [...result.issues, sanitized],
      omittedIssueCount: result.omittedIssueCount - 1,
    };
    if (serializedBytes(candidate, redactor) <= maxBytes) result = candidate;
  }
  const { cause } = taggedErrorJson({ cause: diagnostic.cause });
  if (cause === undefined) return result;
  const redactedCause = redactValueWithPolicy(redactor, diagnosticPolicy, cause);
  const withCause = { ...result, cause: redactedCause };
  return serializedBytes(withCause, redactor) <= maxBytes ? withCause : result;
};

type EventStepRefusal = Pick<LandofileEventStepFailedError, "event" | "index" | "kind" | "service"> &
  RefusalSummary &
  RefusalDetails;

/** Bound a not-run event step after its message prefix and step identity have been assigned. */
export const projectEventStepRefusal = (
  diagnostic: EventStepRefusal,
  redactor: Pick<Redactor, "redactString">,
  limit = MAX_BYTES,
) => {
  const maxBytes = Math.min(limit, MAX_BYTES);
  const summary = {
    _tag: "LandofileEventStepFailedError" as const,
    ...projectSummaries(diagnostic, redactor),
    index: diagnostic.index,
    step: diagnostic.index + 1,
    kind: diagnostic.kind,
    outputTail: "",
  };
  const event = redactor.redactString(diagnostic.event);
  const service =
    diagnostic.service === undefined ? {} : { service: redactor.redactString(diagnostic.service) };
  const fits = (identity: { readonly event: string; readonly service?: string }) =>
    serializedBytes({ ...summary, ...identity, ...emptyDetails(diagnostic) }, redactor) <= maxBytes;
  // Omit whole identities rather than shorten them into plausible but wrong names.
  const identity = fits({ event, ...service })
    ? { event, ...service }
    : fits({ event })
      ? { event }
      : { event: "[omitted]" };
  const { cause, ...bounded } = projectDetails({ ...summary, ...identity }, diagnostic, {
    redactor,
    maxBytes,
  });
  return cause === undefined ? bounded : { ...bounded, cause };
};

const isToolingFailure = Schema.is(Schema.Struct(ToolingCompileError.fields));
const isEventStepFailure = Schema.is(Schema.Struct(LandofileEventStepFailedError.fields));

/** Shared machine and human projection, including refusal bounds at the publication boundary. */
export const projectCommandDiagnostic = (
  error: unknown,
  redactor: Pick<Redactor, "redactString">,
  role?: FailureRole,
): typeof TaggedErrorJson.Type => {
  const diagnostic = taggedErrorJson(error);
  const maxBytes = role === undefined ? MAX_BYTES : MAX_BYTES - serializedBytes({ role }, redactor) + 1;
  if (isToolingFailure(diagnostic)) return projectToolingDiagnostic(diagnostic, redactor, { maxBytes });
  if (isEventStepFailure(diagnostic) && diagnostic.exitCode === undefined && diagnostic.outputTail === "")
    return projectEventStepRefusal(diagnostic, redactor, maxBytes);
  return diagnostic;
};
