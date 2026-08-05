import { scanComments } from "../literals.ts";
import type { BoundaryRule } from "../types.ts";
import { ALL_PACKAGE_SOURCE_ROOTS } from "../workspace-roots.ts";

const BANNER_MARKER = "**GENERATED FILE** — do not edit by hand.";
const BANNERED_OUTSIDE_GENERATED_ALLOWLIST = ["core/src/recipes/bundled.ts"] as const;

const hasGeneratedPathSegment = (path: string): boolean => path.split("/").includes("generated");

const onProgram: NonNullable<BoundaryRule["onProgram"]> = async (context) => {
  for (const file of context.files) {
    const source = await context.sourceFile(file);
    const firstStatementStart = source.statements[0]?.getStart(source) ?? source.end;
    const banner = scanComments(source).find(
      (comment) =>
        comment.end <= firstStatementStart &&
        comment.kind === "block-comment" &&
        comment.value.startsWith("/**") &&
        comment.value.includes(BANNER_MARKER),
    );

    if (hasGeneratedPathSegment(file.relativePath)) {
      if (banner === undefined) {
        context.report(file.relativePath, 1, `missing ${BANNER_MARKER} banner`);
      }
      continue;
    }

    if (banner !== undefined) {
      const markerStart = banner.start + banner.value.indexOf(BANNER_MARKER);
      const { line } = source.getLineAndCharacterOfPosition(markerStart);
      context.report(file.relativePath, line + 1, "**GENERATED FILE** banner outside generated/ path");
    }
  }
};

export const generatedOutputRule = {
  id: "generated-output",
  scope: {
    roots: ALL_PACKAGE_SOURCE_ROOTS,
    extensions: [".ts"],
    excludeTestFiles: true,
  },
  carveOuts: { files: BANNERED_OUTSIDE_GENERATED_ALLOWLIST, prefixes: [] },
  passMessage: "Generated output boundary check passed.",
  failureHeadline: "Generated output boundary check failed.",
  onProgram,
} satisfies BoundaryRule;
