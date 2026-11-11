import { type ConfigLintViolation, LandofileAuthoringFragmentNative } from "@lando/sdk/schema";
import { Result, Schema } from "effect";
import { analyzeComposeRejections } from "./compose/rejections.ts";
import { attributeLintIssue } from "./lint-source.ts";
import { rejectionViolation, violationsFromSchema } from "./lint-violations.ts";
import type { SourceDocument } from "./pipeline/source-table.ts";
import {
  UNSUPPORTED_REMEDIATION,
  scanToolingForUnsupported,
  unsupportedToolingMessage,
} from "./tooling-unsupported.ts";

const refusalViolation = (
  finding: ReturnType<typeof scanToolingForUnsupported>[number],
): ConfigLintViolation => ({
  rule: "landofile.load",
  reason: "NotImplementedError",
  severity: "error",
  path: finding.path,
  message: unsupportedToolingMessage(finding),
  suggestion: finding.remediation ?? UNSUPPORTED_REMEDIATION,
});

/** An included task reports at `tooling.<task>` in its fragment and `tooling.<namespace>:<task>` once composed. */
const sameRefusal = (
  reported: ConfigLintViolation["path"],
  effective: ConfigLintViolation["path"],
): boolean => {
  if (reported.length !== effective.length || reported[0] !== effective[0]) return false;
  const task = (part: string | number | undefined, other: string | number | undefined) =>
    part === other || (effective[0] === "tooling" && String(other).endsWith(`:${String(part)}`));
  return (
    task(reported[1], effective[1]) && reported.slice(2).every((part, index) => part === effective[index + 2])
  );
};

/**
 * True for the load failure the tooling scan raised: its message starts with a scan finding's
 * message, from a fragment finding already reported or from the composed document.
 */
export const isToolingRefusal = (
  composed: unknown,
  reported: readonly ConfigLintViolation[],
  error: { readonly _tag: string; readonly message: string },
) =>
  error._tag === "NotImplementedError" &&
  [
    ...reported
      .filter((violation) => violation.reason === "NotImplementedError")
      .map(({ message }) => message),
    ...scanToolingForUnsupported(composed).map(unsupportedToolingMessage),
  ].some((message) => error.message.startsWith(message));

/**
 * Refused tooling keys in the composed document that no fragment finding already reports, such as
 * a key a merge directive hid from its fragment scan. Each is reported once, at its effective path.
 */
export const unreportedToolingRefusals = (
  composed: unknown,
  reported: readonly ConfigLintViolation[],
  documents: readonly SourceDocument[],
): readonly ConfigLintViolation[] =>
  scanToolingForUnsupported(composed)
    .filter(
      (finding) =>
        !reported.some(
          (violation) =>
            violation.reason === "NotImplementedError" && sameRefusal(violation.path, finding.path),
        ),
    )
    .map((finding) => attributeLintIssue(refusalViolation(finding), "effective", documents));

export const fragmentIssues = (source: SourceDocument): readonly ConfigLintViolation[] => {
  const decoded = Schema.decodeUnknownResult(LandofileAuthoringFragmentNative)(source.document, {
    onExcessProperty: "error",
    errors: "all",
  });
  const rejections = analyzeComposeRejections(source.document);
  const unsupported = scanToolingForUnsupported(source.document);
  if (Result.isSuccess(decoded) && rejections.length === 0 && unsupported.length === 0) return [];
  const issues = [
    ...rejections.map(rejectionViolation),
    ...(Result.isSuccess(decoded)
      ? []
      : violationsFromSchema(decoded.failure.issue, source.document, rejections).filter(
          (issue) => !unsupported.some(({ path }) => path.every((part, index) => part === issue.path[index])),
        )),
    ...unsupported.map(refusalViolation),
  ];
  return issues.map((issue) =>
    attributeLintIssue(
      { ...issue, source: { file: source.file, layer: source.layer, path: issue.path } },
      "fragment",
      [source],
    ),
  );
};
