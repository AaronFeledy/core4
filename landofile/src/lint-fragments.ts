import { type ConfigLintViolation, LandofileAuthoringFragmentNative } from "@lando/sdk/schema";
import { Result, Schema } from "effect";
import { analyzeComposeRejections } from "./compose/rejections.ts";
import { attributeLintIssue } from "./lint-source.ts";
import { rejectionViolation, violationsFromSchema } from "./lint-violations.ts";
import type { SourceDocument } from "./pipeline/source-table.ts";

export const fragmentIssues = (source: SourceDocument): readonly ConfigLintViolation[] => {
  const decoded = Schema.decodeUnknownResult(LandofileAuthoringFragmentNative)(source.document, {
    onExcessProperty: "error",
    errors: "all",
  });
  const rejections = analyzeComposeRejections(source.document);
  if (Result.isSuccess(decoded) && rejections.length === 0) return [];
  const issues = [
    ...rejections.map(rejectionViolation),
    ...(Result.isSuccess(decoded)
      ? []
      : violationsFromSchema(decoded.failure.issue, source.document, rejections)),
  ];
  return issues.map((issue) =>
    attributeLintIssue(
      { ...issue, source: { file: source.file, layer: source.layer, path: issue.path } },
      "fragment",
      [source],
    ),
  );
};
