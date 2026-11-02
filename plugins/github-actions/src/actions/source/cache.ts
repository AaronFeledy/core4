import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import { StateStore } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { snapshotSourceJson } from "./admission.ts";
import { sourceError } from "./errors.ts";
import {
  ResolvedReferenceSchema,
  TrustedManifestSchema,
  type TrustedSourceManifest,
  type VerifiedActionSource,
  capturedSource,
  sourceCacheIdentity,
  sourceLimits,
  validateResolvedReference,
  verifyFixtureSource,
} from "./fixture.ts";
import type { ResolvedRepositoryReference } from "./reference.ts";

const CachedSelection = Schema.Struct({
  manifest: TrustedManifestSchema,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String.check(Schema.isMaxLength(1024)),
      base64: Schema.String.check(Schema.isMaxLength(Math.ceil(sourceLimits.fileBytes / 3) * 4)),
    }),
  ).check(Schema.isMaxLength(sourceLimits.files)),
});
const CachedRepository = Schema.Struct({
  selections: Schema.Record(Schema.String.check(Schema.isMaxLength(64)), CachedSelection).check(
    Schema.isMaxProperties(sourceLimits.files),
  ),
});
const selectionKey = (reference: ResolvedRepositoryReference) => sha256Hex(reference.subpath);
const openCache = Effect.fn("ActionSource.openCache")(function* (reference: ResolvedRepositoryReference) {
  const store = yield* StateStore;
  return yield* store
    .open({
      root: "userCache",
      namespace: "github-actions-source",
      key: `${sourceCacheIdentity(reference)}.json`,
      schema: CachedRepository,
      version: 1,
      mode: 0o600,
      lock: "advisory",
      onCorrupt: "fail",
    })
    .pipe(Effect.mapError(() => sourceError("cache-failed", reference.source)));
});
/** The caller supplies the SDK store; this private fixture kernel installs no production persistence layer. */
export const cacheVerifiedSource = Effect.fn("ActionSource.cacheVerifiedSource")(function* (
  source: VerifiedActionSource,
) {
  const captured = capturedSource(source);
  if (captured === undefined) return yield* sourceError("integrity-mismatch", { file: "action-source" });
  const bucket = yield* openCache(captured.reference);
  const selection = {
    manifest: captured.manifest,
    files: captured.files.map((file) => ({
      path: file.path,
      base64: Buffer.from(file.bytes).toString("base64"),
    })),
  };
  const key = selectionKey(captured.reference);
  const stored = yield* bucket
    .modify((current) => {
      const selections = current?.selections ?? {};
      if (!(key in selections) && Object.keys(selections).length >= sourceLimits.files)
        return [false, { selections }] as const;
      let encodedBytes = 0;
      let fileCount = 0;
      // Bound the repository's full retained payload before constructing the replacement record.
      for (const selected of [
        ...Object.entries(selections)
          .filter(([selectedKey]) => selectedKey !== key)
          .map(([, value]) => value),
        selection,
      ]) {
        fileCount += selected.files.length;
        if (fileCount > sourceLimits.files) return [false, { selections }] as const;
        for (const file of selected.files) {
          encodedBytes += file.base64.length;
          if (encodedBytes > Math.ceil(sourceLimits.totalBytes / 3) * 4 + sourceLimits.files * 4)
            return [false, { selections }] as const;
        }
      }
      return [true, { selections: { ...selections, [key]: selection } }] as const;
    })
    .pipe(Effect.mapError(() => sourceError("cache-failed", captured.reference.source)));
  if (!stored) return yield* sourceError("source-limit", captured.reference.source);
  return source.receipt;
});
/** Every hit is checked against independent authority supplied for this invocation, never the cache's own checksum. */
export const loadCachedSource = Effect.fn("ActionSource.loadCachedSource")(function* (
  referenceInput: ResolvedRepositoryReference,
  expectedInput: TrustedSourceManifest,
) {
  const admitted = yield* Effect.try({
    try: () => ({
      reference: Schema.decodeUnknownSync(ResolvedReferenceSchema)(snapshotSourceJson(referenceInput)),
      expected: Schema.decodeUnknownSync(TrustedManifestSchema)(snapshotSourceJson(expectedInput)),
    }),
    catch: () => sourceError("invalid-reference", { file: "action-source" }),
  });
  const { reference, expected } = admitted;
  yield* validateResolvedReference(reference);
  const bucket = yield* openCache(reference);
  const repository = yield* bucket.get.pipe(
    Effect.mapError(() => sourceError("cache-failed", reference.source)),
  );
  if (repository !== null && Object.keys(repository.selections).length > sourceLimits.files)
    return yield* sourceError("source-limit", reference.source);
  const cached = repository?.selections[selectionKey(reference)];
  if (cached === undefined) return yield* sourceError("offline-miss", reference.source);
  const cachedManifest = yield* Effect.try({
    try: () => snapshotSourceJson(cached.manifest),
    catch: () => sourceError("source-limit", reference.source),
  });
  if (canonicalJson(cachedManifest) !== canonicalJson(expected))
    return yield* sourceError("integrity-mismatch", reference.source);
  if (cached.files.length > sourceLimits.files) return yield* sourceError("source-limit", reference.source);
  let total = 0;
  const files = [];
  for (const file of cached.files) {
    if (file.path.length > 1024) return yield* sourceError("invalid-reference", reference.source);
    // Refuse an oversized encoding before decoding; StateStore itself remains the host's IO owner.
    if (file.base64.length > Math.ceil(sourceLimits.fileBytes / 3) * 4)
      return yield* sourceError("source-limit", reference.source);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(file.base64))
      return yield* sourceError("integrity-mismatch", reference.source);
    const bytes = new Uint8Array(Buffer.from(file.base64, "base64"));
    total += bytes.byteLength;
    if (total > sourceLimits.totalBytes) return yield* sourceError("source-limit", reference.source);
    files.push({ path: file.path, bytes });
  }
  return yield* verifyFixtureSource(reference, expected, files);
});
