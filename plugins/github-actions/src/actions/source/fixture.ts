import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import { Effect, Schema } from "effect";
import { LanguageSourceSchema } from "../../language/errors.ts";
import { snapshotSourceJson } from "./admission.ts";
import { sourceError } from "./errors.ts";
import { type ResolvedRepositoryReference, parseActionReference, validSourcePath } from "./reference.ts";

export const sourceLimits = Object.freeze({
  files: 100,
  fileBytes: 256 * 1024,
  totalBytes: 8 * 1024 * 1024,
} as const);
export interface FixtureFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}
export interface TrustedSourceManifest {
  readonly origin: string;
  readonly repository: string;
  readonly commit: string;
  readonly subpath: string;
  readonly metadataPath: string;
  readonly files: readonly { readonly path: string; readonly size: number; readonly sha256: string }[];
  readonly licenses: readonly string[];
}
const SourcePathText = Schema.String.check(Schema.isMaxLength(1024));
export const TrustedManifestSchema = Schema.Struct({
  origin: Schema.String.check(Schema.isMaxLength(2048)),
  repository: Schema.String.check(Schema.isMaxLength(140)),
  commit: Schema.String.check(Schema.isMaxLength(40)),
  subpath: SourcePathText,
  metadataPath: SourcePathText,
  files: Schema.Array(
    Schema.Struct({
      path: SourcePathText,
      size: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: sourceLimits.fileBytes })),
      sha256: Schema.String.check(Schema.isMaxLength(64)),
    }),
  ).check(Schema.isMaxLength(sourceLimits.files)),
  licenses: Schema.Array(SourcePathText).check(Schema.isMaxLength(sourceLimits.files)),
});
export const ResolvedReferenceSchema = Schema.Struct({
  kind: Schema.Literal("repository"),
  origin: Schema.String,
  repository: Schema.String,
  requestedRef: Schema.String,
  subpath: Schema.String,
  commit: Schema.String,
  provenance: Schema.Literals(["immutable-pin", "trusted-fixture"]),
  source: LanguageSourceSchema,
});
export interface SourceReceipt {
  readonly origin: string;
  readonly repository: string;
  readonly requestedRef: string;
  readonly commit: string;
  readonly provenance: "immutable-pin" | "trusted-fixture";
  readonly subpath: string;
  readonly metadataPath: string;
  readonly integrity: string;
  readonly licenses: readonly string[];
  readonly verification: "trusted-fixture-bytes";
}
declare const verifiedSource: unique symbol;
export interface VerifiedActionSource {
  readonly [verifiedSource]: true;
  readonly reference: ResolvedRepositoryReference;
  readonly receipt: SourceReceipt;
}
interface CapturedSource {
  readonly reference: ResolvedRepositoryReference;
  readonly manifest: TrustedSourceManifest;
  readonly files: readonly FixtureFile[];
}
const admittedSources = new WeakMap<VerifiedActionSource, CapturedSource>();
export const capturedSource = (source: VerifiedActionSource): CapturedSource | undefined =>
  admittedSources.get(source);
export const sourceCapabilities = Object.freeze({
  remoteTransport: "gated",
  archiveExtraction: "gated",
  localMaterialization: "gated",
  physicalPersistence: "host-supplied-unverified",
} as const);
export const sourceCacheIdentity = (reference: ResolvedRepositoryReference): string =>
  sha256Hex(
    canonicalJson({
      origin: reference.origin,
      repository: reference.repository,
      commit: reference.commit,
    }),
  );
export const validateResolvedReference = Effect.fn("ActionSource.validateResolvedReference")(function* (
  reference: ResolvedRepositoryReference,
) {
  const fail = (reason: Parameters<typeof sourceError>[0]) => sourceError(reason, reference.source);
  const parsed = yield* parseActionReference(
    `${reference.repository}${reference.subpath ? `/${reference.subpath}` : ""}@${reference.requestedRef}`,
    reference.source,
    { origin: reference.origin },
  );
  if (
    parsed.kind !== "repository" ||
    parsed.repository !== reference.repository ||
    parsed.origin !== reference.origin ||
    !/^[a-f0-9]{40}$/u.test(reference.commit) ||
    (parsed.commit !== undefined && parsed.commit !== reference.commit) ||
    reference.provenance !== (parsed.commit === undefined ? "trusted-fixture" : "immutable-pin")
  )
    return yield* fail("integrity-mismatch");
  return reference;
});
export const verifyFixtureSource = Effect.fn("ActionSource.verifyFixtureSource")(function* (
  referenceInput: ResolvedRepositoryReference,
  manifestInput: TrustedSourceManifest,
  filesInput: readonly FixtureFile[],
) {
  const admission = yield* Effect.try({
    try: () => {
      const admittedReference = Schema.decodeUnknownSync(ResolvedReferenceSchema)(
        snapshotSourceJson(referenceInput),
      );
      const admittedManifest = Schema.decodeUnknownSync(TrustedManifestSchema)(
        snapshotSourceJson(manifestInput),
      );
      // Byte buffers are a separate finite fixture boundary, never JSON or archive entries.
      if (
        !Array.isArray(filesInput) ||
        Object.getPrototypeOf(filesInput) !== Array.prototype ||
        filesInput.length > sourceLimits.files
      )
        throw new Error();
      const descriptors = Object.getOwnPropertyDescriptors(filesInput);
      if (Reflect.ownKeys(descriptors).length !== filesInput.length + 1) throw new Error();
      let total = 0;
      const admittedFiles: FixtureFile[] = [];
      for (let i = 0; i < filesInput.length; i++) {
        const entry = descriptors[String(i)];
        if (entry === undefined || !("value" in entry)) throw new Error();
        const file: unknown = entry.value;
        if (file === null || typeof file !== "object" || Object.getPrototypeOf(file) !== Object.prototype)
          throw new Error();
        const fields = Object.getOwnPropertyDescriptors(file);
        if (
          Reflect.ownKeys(fields).length !== 2 ||
          fields.path === undefined ||
          fields.bytes === undefined ||
          !("value" in fields.path) ||
          !("value" in fields.bytes) ||
          typeof fields.path.value !== "string"
        )
          throw new Error();
        const bytes: unknown = fields.bytes.value;
        if (
          !(bytes instanceof Uint8Array) ||
          Object.getPrototypeOf(bytes) !== Uint8Array.prototype ||
          Object.hasOwn(bytes, "byteLength") ||
          Object.hasOwn(bytes, "buffer") ||
          Object.hasOwn(bytes, "byteOffset")
        )
          throw new Error();
        if (bytes.byteLength > sourceLimits.fileBytes || total + bytes.byteLength > sourceLimits.totalBytes)
          return { limit: true as const };
        if (Reflect.ownKeys(bytes).length !== bytes.byteLength) throw new Error();
        total += bytes.byteLength;
        admittedFiles.push({ path: fields.path.value, bytes: new Uint8Array(bytes) });
      }
      snapshotSourceJson(admittedFiles.map((file) => ({ path: file.path })));
      return {
        limit: false as const,
        reference: admittedReference,
        manifest: admittedManifest,
        files: admittedFiles,
      };
    },
    catch: () => sourceError("invalid-reference", { file: "action-source" }),
  });
  if (admission.limit) return yield* sourceError("source-limit", { file: "action-source" });
  const { reference, manifest, files } = admission;
  const fail = (reason: Parameters<typeof sourceError>[0]) => sourceError(reason, reference.source);
  yield* validateResolvedReference(reference);
  if (manifest.origin !== reference.origin) return yield* fail("origin-mismatch");
  if (
    manifest.repository !== reference.repository ||
    manifest.commit !== reference.commit ||
    manifest.subpath !== reference.subpath
  )
    return yield* fail("integrity-mismatch");
  const metadataCandidates = [
    `${reference.subpath ? `${reference.subpath}/` : ""}action.yml`,
    `${reference.subpath ? `${reference.subpath}/` : ""}action.yaml`,
  ];
  const reusable = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(reference.subpath);
  if (
    !(reusable
      ? manifest.metadataPath === reference.subpath
      : metadataCandidates.includes(manifest.metadataPath))
  )
    return yield* fail("integrity-mismatch");
  if (
    manifest.files.length === 0 ||
    manifest.files.length > sourceLimits.files ||
    files.length > sourceLimits.files
  )
    return yield* fail("source-limit");
  const expectedPaths = new Set<string>();
  for (const file of manifest.files) {
    if (!validSourcePath(file.path)) return yield* fail("invalid-reference");
    if (
      expectedPaths.has(file.path) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !/^[a-f0-9]{64}$/u.test(file.sha256)
    )
      return yield* fail("integrity-mismatch");
    if (file.size > sourceLimits.fileBytes) return yield* fail("source-limit");
    expectedPaths.add(file.path);
  }
  if (
    !expectedPaths.has(manifest.metadataPath) ||
    manifest.licenses.length === 0 ||
    manifest.licenses.length > sourceLimits.files ||
    manifest.licenses.some((path) => !expectedPaths.has(path))
  )
    return yield* fail("integrity-mismatch");
  const actualPaths = new Set<string>();
  let total = 0;
  const captured: FixtureFile[] = [];
  for (const file of files) {
    if (!validSourcePath(file.path)) return yield* fail("invalid-reference");
    if (actualPaths.has(file.path)) return yield* fail("integrity-mismatch");
    actualPaths.add(file.path);
    // This boundary accepts already bounded fixture buffers, never a transport or archive stream.
    if (
      file.bytes.byteLength > sourceLimits.fileBytes ||
      total + file.bytes.byteLength > sourceLimits.totalBytes
    )
      return yield* fail("source-limit");
    total += file.bytes.byteLength;
    const expected = manifest.files.find((item) => item.path === file.path);
    if (
      expected === undefined ||
      expected.size !== file.bytes.byteLength ||
      sha256Hex(file.bytes) !== expected.sha256
    )
      return yield* fail("integrity-mismatch");
    captured.push({ path: file.path, bytes: new Uint8Array(file.bytes) });
  }
  if (actualPaths.size !== expectedPaths.size) return yield* fail("integrity-mismatch");
  const trusted = Object.freeze({
    ...manifest,
    files: Object.freeze(manifest.files.map((file) => Object.freeze({ ...file }))),
    licenses: Object.freeze([...manifest.licenses]),
  });
  const receipt: SourceReceipt = {
    origin: reference.origin,
    repository: reference.repository,
    requestedRef: reference.requestedRef,
    commit: reference.commit,
    provenance: reference.provenance,
    subpath: reference.subpath,
    metadataPath: manifest.metadataPath,
    integrity: sha256Hex(canonicalJson(trusted)),
    licenses: [...manifest.licenses],
    verification: "trusted-fixture-bytes",
  };
  const capturedReference = Object.freeze({ ...reference, source: Object.freeze({ ...reference.source }) });
  const handle = Object.freeze({
    reference: capturedReference,
    receipt: Object.freeze({ ...receipt, licenses: Object.freeze([...receipt.licenses]) }),
  }) as VerifiedActionSource;
  admittedSources.set(handle, { reference: capturedReference, manifest: trusted, files: captured });
  return handle;
});
