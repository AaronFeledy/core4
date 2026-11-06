import { Effect } from "effect";
import { parseActionLanguage, parseWorkflowLanguage } from "../../language/parse.ts";
import { sourceError } from "./errors.ts";
import { type VerifiedActionSource, capturedSource } from "./fixture.ts";

export const loadActionMetadata = Effect.fn("ActionSource.loadMetadata")(function* (
  source: VerifiedActionSource,
) {
  const verified = capturedSource(source);
  if (verified === undefined) return yield* sourceError("integrity-mismatch", { file: "action-source" });
  const location = { file: verified.manifest.metadataPath };
  const file = verified.files.find((value) => value.path === verified.manifest.metadataPath);
  if (file === undefined) return yield* sourceError("metadata-invalid", location);
  const content = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
    catch: () => sourceError("metadata-invalid", location),
  });
  if (/^\.github\/workflows\//u.test(verified.reference.subpath)) {
    const parsed = yield* parseWorkflowLanguage(location.file, content).pipe(
      Effect.mapError((error) => sourceError("metadata-invalid", error.source)),
    );
    return { kind: "reusable-workflow" as const, parsed, receipt: source.receipt };
  }
  const parsed = yield* parseActionLanguage(location.file, content).pipe(
    Effect.mapError((error) => sourceError("metadata-invalid", error.source)),
  );
  const kind = parsed.action.runs.using;
  if (kind !== "node20" && kind !== "node24" && kind !== "composite" && kind !== "docker")
    return yield* sourceError("metadata-invalid", location);
  return { kind, parsed, receipt: source.receipt };
});
