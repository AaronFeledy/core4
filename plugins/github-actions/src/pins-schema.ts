import { isAbsolute, normalize, parse, resolve, sep } from "node:path";
import { Effect, Schema } from "effect";

// Private catalog failures contain only fixed, allowlisted diagnostics.
const remedies = {
  "invalid-catalog": "Regenerate the reviewed GitHub Actions pin catalog and verify upstream receipts.",
  "unsupported-runtime":
    "Request node20 or node24 explicitly for Linux x64 or arm64 with glibc and a pinned source. Alpine and musl are unverified.",
  "unsupported-image": "Select an explicit pinned Linux image candidate id with its matching architecture.",
  "no-reviewed-default":
    "No image default has passed provider acceptance; select a candidate for inspection only.",
  "provider-acceptance-unverified":
    "Complete separate provider and runtime acceptance before admitting a workload.",
  "invalid-download-request":
    "Choose a catalog artifact, a normalized absolute host destination directory, and explicit offline intent.",
  "download-receipt-mismatch":
    "Ask the trusted host downloader to acquire the exact pinned file and return its matching receipt.",
  "offline-artifact-missing":
    "Provision and verify the pinned artifact through the host downloader before retrying offline.",
  "artifact-missing":
    "Acquire the pinned artifact through the host downloader before validating its receipt.",
} as const;
export class GithubActionsPinError extends Schema.TaggedError<GithubActionsPinError>()(
  "GithubActionsPinError",
  {
    message: Schema.Literal("GitHub Actions pin selection failed."),
    reason: Schema.Literals([
      "invalid-catalog",
      "unsupported-runtime",
      "unsupported-image",
      "no-reviewed-default",
      "provider-acceptance-unverified",
      "invalid-download-request",
      "download-receipt-mismatch",
      "offline-artifact-missing",
      "artifact-missing",
    ]),
    remediation: Schema.Literals(Object.values(remedies)),
  },
) {}
export const pinError = (reason: keyof typeof remedies) =>
  new GithubActionsPinError({
    message: "GitHub Actions pin selection failed.",
    reason,
    remediation: remedies[reason],
  });

// Exact supported identities; availability is independent of workload acceptance.
export const RUNNER_VERSION = "2.338.1";
export const RUNNER_SOURCE_COMMIT = "e78522a9a7b01c3bcd7ac0da6e3a9bb6cd513a76";
export const NODE_SOURCE_COMMITS = {
  node20: "3626fea570e44896ad99aaf3bf6e59def5adede5",
  node24: "ce7aaf1cee78b8cf0ce17364260535c418d3ed26",
} as const;
export const NODE_VERSIONS = { node20: "20.20.2", node24: "24.22.1" } as const;
const Arch = Schema.Literals(["x64", "arm64"]);
const Runtime = Schema.Literals(["node20", "node24"]);
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u));
const Size = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000_000_000));
const Text = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.isPattern(/^[^\p{Cc}\p{Cf}]+$/u),
);
const PlatformFields = { os: Schema.Literal("linux"), arch: Arch, libc: Schema.Literal("glibc") };
export const RuntimeRequest = Schema.Struct({
  ...PlatformFields,
  runtime: Runtime,
  source: Schema.Literals(["nodejs", "runner-externals"]),
});
export const RunnerArchiveRequest = Schema.Struct(PlatformFields);
export const ImageCandidateRequest = Schema.Struct({
  id: Schema.Literals(["actions-runner-2.338.1-linux-x64", "actions-runner-2.338.1-linux-arm64"]),
  os: Schema.Literal("linux"),
  arch: Arch,
});
export const ArtifactId = Schema.Literals([
  "actions-runner-linux-x64-2.338.1.tar.gz",
  "actions-runner-linux-arm64-2.338.1.tar.gz",
  "node-v20.20.2-linux-x64.tar.gz",
  "node-v20.20.2-linux-arm64.tar.gz",
  "node-v24.22.1-linux-x64.tar.gz",
  "node-v24.22.1-linux-arm64.tar.gz",
]);
export const DownloadOptions = Schema.Struct({
  artifactId: ArtifactId,
  directory: Schema.String.check(
    Schema.isMaxLength(4096),
    Schema.isPattern(/^[^\p{Cc}\p{Cf}]+$/u),
    Schema.makeFilter(
      (directory) =>
        isAbsolute(directory) &&
        normalize(directory) === directory &&
        resolve(directory) === directory &&
        parse(directory).root !== directory &&
        !directory.endsWith(sep),
    ),
  ),
  offline: Schema.Boolean,
});

// Catalog records describe upstream artifacts and relative archive layout only.
export const ArchivePin = Schema.Struct({
  ...PlatformFields,
  id: ArtifactId,
  filename: ArtifactId,
  kind: Schema.Literals(["node-archive", "runner-archive"]),
  version: Schema.Literals(["2.338.1", "20.20.2", "24.22.1"]),
  url: Text,
  checksumSourceUrl: Text,
  sha256: Sha256,
  sizeBytes: Size,
  archive: Schema.Literal("tar.gz"),
  noticeIds: Schema.Array(Schema.Literals(["runner", "node20", "node24"])).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(3),
  ),
});
export type ArchivePin = typeof ArchivePin.Type;
export const BinaryPin = Schema.Struct({
  sha256: Sha256,
  sizeBytes: Size,
  elfMachine: Schema.Literals([62, 183]),
  elfClass: Schema.Literal(64),
  endianness: Schema.Literal("little"),
});
export const NodeRuntimePin = Schema.Struct({
  ...RuntimeRequest.fields,
  id: Text,
  nodeVersion: Schema.Literals(["20.20.2", "24.22.1"]),
  sourceCommit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  artifactId: ArtifactId,
  member: Text,
  binary: BinaryPin,
  runnerRelativePath: Schema.optionalKey(Text),
  containerCompatibility: Schema.Literal("unverified"),
});
export type NodeRuntimePin = typeof NodeRuntimePin.Type;
export const ImagePin = Schema.Struct({
  ...PlatformFields,
  id: ImageCandidateRequest.fields.id,
  image: Text,
  repository: Schema.Literal("ghcr.io/actions/actions-runner"),
  indexDigest: Digest,
  manifestDigest: Digest,
  configDigest: Digest,
  discoveryTag: Schema.Literal("2.338.1"),
  releaseUrl: Schema.Literal("https://github.com/actions/runner/releases/tag/v2.338.1"),
  runnerSourceConformanceCommit: Schema.Literal(RUNNER_SOURCE_COMMIT),
  buildProvenance: Schema.Literal("unverified"),
  providerAcceptance: Schema.Literal("unverified"),
});
export type ImagePin = typeof ImagePin.Type;
const Notice = Schema.Struct({
  id: Schema.Literals(["runner", "node20", "node24"]),
  path: Text,
  sourceUrl: Text,
  sha256: Sha256,
  scope: Schema.Literals(["upstream-runner-source", "nodejs-distribution"]),
  license: Schema.Literals(["MIT", "MIT-with-third-party-notices"]),
});
const SourceFile = Schema.Struct({
  path: Schema.Literals(["src/Misc/externals.sh", "images/Dockerfile"]),
  sourceUrl: Text,
  sha256: Sha256,
});
export const PinCatalog = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  runner: Schema.Struct({
    version: Schema.Literal(RUNNER_VERSION),
    sourceCommit: Schema.Literal(RUNNER_SOURCE_COMMIT),
    sourceUrl: Schema.Literal(`https://github.com/actions/runner/tree/${RUNNER_SOURCE_COMMIT}`),
    sourceFiles: Schema.Array(SourceFile).check(Schema.isMinLength(2), Schema.isMaxLength(2)),
  }),
  artifacts: Schema.Array(ArchivePin).check(Schema.isMinLength(6), Schema.isMaxLength(6)),
  nodeRuntimes: Schema.Array(NodeRuntimePin).check(Schema.isMinLength(8), Schema.isMaxLength(8)),
  images: Schema.Array(ImagePin).check(Schema.isMinLength(2), Schema.isMaxLength(2)),
  notices: Schema.Array(Notice).check(Schema.isMinLength(3), Schema.isMaxLength(3)),
});
export type PinCatalog = typeof PinCatalog.Type;

const consistent = (catalog: PinCatalog): boolean => {
  if (
    [catalog.artifacts, catalog.nodeRuntimes, catalog.images, catalog.notices].some(
      (records) => new Set(records.map((record) => record.id)).size !== records.length,
    )
  )
    return false;
  if (new Set(catalog.runner.sourceFiles.map((file) => file.path)).size !== 2) return false;
  for (const file of catalog.runner.sourceFiles) {
    if (
      file.sourceUrl !==
      `https://raw.githubusercontent.com/actions/runner/${RUNNER_SOURCE_COMMIT}/${file.path}`
    )
      return false;
  }
  for (const artifact of catalog.artifacts) {
    if (artifact.id !== artifact.filename) return false;
    if (artifact.kind === "runner-archive") {
      if (
        artifact.version !== RUNNER_VERSION ||
        artifact.filename !== `actions-runner-linux-${artifact.arch}-${RUNNER_VERSION}.tar.gz` ||
        artifact.url !==
          `https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${artifact.filename}` ||
        artifact.checksumSourceUrl !== `https://github.com/actions/runner/releases/tag/v${RUNNER_VERSION}` ||
        artifact.noticeIds.join(",") !== "runner,node20,node24"
      )
        return false;
    } else {
      const runtime =
        artifact.version === NODE_VERSIONS.node20
          ? "node20"
          : artifact.version === NODE_VERSIONS.node24
            ? "node24"
            : undefined;
      if (
        !runtime ||
        artifact.filename !== `node-v${artifact.version}-linux-${artifact.arch}.tar.gz` ||
        artifact.url !== `https://nodejs.org/dist/v${artifact.version}/${artifact.filename}` ||
        artifact.checksumSourceUrl !== `https://nodejs.org/dist/v${artifact.version}/SHASUMS256.txt` ||
        artifact.noticeIds.join(",") !== runtime
      )
        return false;
    }
  }
  for (const pin of catalog.nodeRuntimes) {
    const artifact = catalog.artifacts.find((entry) => entry.id === pin.artifactId);
    if (
      !artifact ||
      pin.id !== `${pin.runtime}-linux-${pin.arch}-${pin.source}` ||
      pin.nodeVersion !== NODE_VERSIONS[pin.runtime] ||
      pin.sourceCommit !== NODE_SOURCE_COMMITS[pin.runtime] ||
      artifact.arch !== pin.arch ||
      pin.binary.elfMachine !== (pin.arch === "x64" ? 62 : 183)
    )
      return false;
    if (pin.source === "nodejs") {
      if (
        artifact.kind !== "node-archive" ||
        artifact.version !== pin.nodeVersion ||
        pin.member !== `node-v${pin.nodeVersion}-linux-${pin.arch}/bin/node` ||
        pin.runnerRelativePath !== undefined
      )
        return false;
    } else {
      const standalone = catalog.nodeRuntimes.find(
        (entry) => entry.source === "nodejs" && entry.runtime === pin.runtime && entry.arch === pin.arch,
      );
      if (
        artifact.kind !== "runner-archive" ||
        pin.member !== `./externals/${pin.runtime}/bin/node` ||
        pin.runnerRelativePath !== `externals/${pin.runtime}/bin/node` ||
        !standalone ||
        pin.binary.sha256 !== standalone.binary.sha256 ||
        pin.binary.sizeBytes !== standalone.binary.sizeBytes
      )
        return false;
    }
  }
  for (const image of catalog.images) {
    if (
      image.id !== `actions-runner-${RUNNER_VERSION}-linux-${image.arch}` ||
      image.image !== `${image.repository}@${image.manifestDigest}` ||
      image.manifestDigest === image.indexDigest ||
      image.manifestDigest === image.configDigest
    )
      return false;
  }
  if (
    catalog.images[0]?.arch === catalog.images[1]?.arch ||
    catalog.images[0]?.manifestDigest === catalog.images[1]?.manifestDigest ||
    catalog.images[0]?.indexDigest !== catalog.images[1]?.indexDigest ||
    catalog.images[0]?.configDigest === catalog.images[1]?.configDigest
  )
    return false;
  for (const notice of catalog.notices) {
    const runner = notice.id === "runner";
    const commit = runner ? RUNNER_SOURCE_COMMIT : NODE_SOURCE_COMMITS[notice.id];
    if (
      notice.path !== `pins-notices/${notice.id}-LICENSE` ||
      notice.sourceUrl !==
        `https://raw.githubusercontent.com/${runner ? "actions/runner" : "nodejs/node"}/${commit}/LICENSE` ||
      notice.scope !== (runner ? "upstream-runner-source" : "nodejs-distribution") ||
      notice.license !== (runner ? "MIT" : "MIT-with-third-party-notices")
    )
      return false;
  }
  return true;
};
export const decodePinCatalog = (input: unknown) =>
  Schema.decodeUnknownEffect(PinCatalog)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => pinError("invalid-catalog")),
    Effect.flatMap((catalog) =>
      consistent(catalog) ? Effect.succeed(catalog) : Effect.fail(pinError("invalid-catalog")),
    ),
  );
