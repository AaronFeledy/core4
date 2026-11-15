import { basename } from "node:path";
import type { ConfigLintViolation } from "@lando/sdk/schema";
import type { Effect } from "effect";
import { LANDOFILE_LAYER_POSITIONS } from "./layers.ts";
import { sourceCoordinates } from "./lint-source.ts";
import type { finalizeLandofile } from "./pipeline/finalize.ts";
import type { SourceDocument } from "./pipeline/source-table.ts";
import type { inspectLandofileRootLayers } from "./root-compile.ts";

type LoadError = Exclude<
  | Effect.Error<ReturnType<typeof finalizeLandofile>>
  | Effect.Error<ReturnType<typeof inspectLandofileRootLayers>>,
  { readonly _tag: "LandofileLoadError" | "LandofileFormConflictError" }
>;

export const loadFailureViolation = (
  error: LoadError,
  context: {
    readonly file: string;
    readonly scope: "fragment" | "effective";
    readonly documents: readonly SourceDocument[];
  },
): ConfigLintViolation => {
  const { file, scope, documents } = context;
  const diagnosticSource = error._tag === "ConfigExpressionError" ? error.source : undefined;
  const path =
    error._tag === "LandofileIncludeError"
      ? (error.path ?? [])
      : error._tag === "ConfigExpressionError"
        ? error.path
        : error._tag === "LandofileLoadOutsideRootError" || error._tag === "LandofileLoadLimitError"
          ? (error.path ?? [])
          : error._tag === "LandofileImportRefMisuseError"
            ? error.configPath.split(".").map((key) => (/^\d+$/.test(key) ? Number(key) : key))
            : error._tag === "LandofileParseError"
              ? (error.sourcePath ?? [])
              : [];
  let errorFile = file;
  if (diagnosticSource !== undefined && "file" in diagnosticSource) {
    errorFile = diagnosticSource.file;
  } else if (error._tag === "LandofileIncludeError" && error.file !== undefined) {
    errorFile = error.file;
  } else if ("sourceFile" in error) {
    errorFile = error.sourceFile ?? ("filePath" in error ? error.filePath : file);
  } else if ("filePath" in error) {
    errorFile = error.filePath;
  } else if ("sourcePath" in error && typeof error.sourcePath === "string") {
    errorFile = error.sourcePath;
  }
  const retained = documents.find(
    (document) =>
      document.file === errorFile &&
      (diagnosticSource === undefined ||
        !("layer" in diagnosticSource) ||
        document.layer === diagnosticSource.layer),
  );
  const layer =
    ("layer" in error ? error.layer : undefined) ??
    retained?.layer ??
    LANDOFILE_LAYER_POSITIONS.find((position) => basename(errorFile).startsWith(`${position.basename}.`))
      ?.layer ??
    "canonical";
  return {
    rule: "landofile.load",
    reason: error._tag,
    severity: "error",
    path,
    scopes: [scope],
    source: diagnosticSource ?? { file: errorFile, layer, path },
    message: error.message,
    ...(error._tag === "LandofileParseError" && error.sourcePath === undefined
      ? {
          ...(error.line === undefined ? {} : { line: error.line }),
          ...(error.column === undefined ? {} : { column: error.column }),
        }
      : retained === undefined || path.length === 0
        ? {}
        : sourceCoordinates(retained, diagnosticSource?.path ?? path)),
    ...("remediation" in error && error.remediation !== undefined ? { suggestion: error.remediation } : {}),
  };
};
