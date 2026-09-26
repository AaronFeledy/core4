import { ConfigTranslateError } from "@lando/sdk/errors";
import { type ConfigTranslateDocument, ConfigTranslateSourceId, type PortablePath } from "@lando/sdk/schema";
import { Effect } from "effect";
import { layerForSourcePath } from "./app-config-translate-document-set.ts";
import { mediaTypeForSourcePath, resolveContainedSourcePath } from "./app-config-translate-sources.ts";

export const CONFIG_TRANSLATE_MAX_DOCUMENT_BYTES = 1_048_576;

export const readTranslateDocuments = (
  appRoot: string,
  files: ReadonlyArray<PortablePath>,
  explicit: ReadonlyArray<PortablePath>,
): Effect.Effect<ReadonlyArray<ConfigTranslateDocument>, ConfigTranslateError> =>
  Effect.gen(function* () {
    const documents: ConfigTranslateDocument[] = [];
    for (const path of files) {
      const contained = resolveContainedSourcePath(appRoot, path);
      const resolved = explicit.includes(path)
        ? yield* contained
        : yield* contained.pipe(
            Effect.match({
              onFailure: () => undefined,
              onSuccess: (value) => value,
            }),
          );
      if (resolved === undefined) continue;
      const bytes = yield* Effect.tryPromise({
        try: () =>
          Bun.file(resolved)
            .slice(0, CONFIG_TRANSLATE_MAX_DOCUMENT_BYTES + 1)
            .bytes(),
        catch: (cause) =>
          new ConfigTranslateError({
            message: `Could not read translation source ${path}.`,
            cause,
            remediation: "Check that the source file exists and is readable.",
          }),
      });
      if (bytes.byteLength > CONFIG_TRANSLATE_MAX_DOCUMENT_BYTES) {
        if (explicit.includes(path))
          return yield* Effect.fail(
            new ConfigTranslateError({
              message: `Translation source ${path} exceeds ${CONFIG_TRANSLATE_MAX_DOCUMENT_BYTES} bytes.`,
              remediation: "Reduce the source file to at most 1 MiB before passing --file.",
            }),
          );
        continue;
      }
      documents.push({
        sourceId: ConfigTranslateSourceId.make(path),
        layerId: layerForSourcePath(path),
        path,
        mediaType: mediaTypeForSourcePath(path),
        contentDigest: `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`,
        bytes,
      });
    }
    return documents;
  });
