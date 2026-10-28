import { describe, expect, it } from "bun:test";
import { sha256Hex } from "@lando/sdk/digest";
import { Effect } from "effect";
import {
  loadActionMetadata,
  parseActionReference,
  resolveFixtureReference,
  sourceCapabilities,
  verifyFixtureSource,
} from "../src/actions/source/index.ts";

const source = { file: ".github/workflows/check.yml", line: 5, column: 9 };
const commit = "a".repeat(40);
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const failure = async <A, E>(effect: Effect.Effect<A, E>) => {
  const result = await run(Effect.result(effect));
  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") throw new Error("Expected failure");
  return result.failure;
};
const fixture = async (
  content = "name: fixture\ndescription: fixture metadata\nruns:\n  using: node24\n  main: main.js\n",
) => {
  const reference = await run(parseActionReference(`Owner/Repo/tool@${commit}`, source));
  if (reference.kind !== "repository") throw new Error("Expected repository");
  const resolved = await run(resolveFixtureReference(reference));
  const bytes = new TextEncoder().encode(content);
  const license = new TextEncoder().encode("MIT fixture license\n");
  const manifest = {
    origin: "https://github.com",
    repository: "owner/repo",
    commit,
    subpath: "tool",
    metadataPath: "tool/action.yml",
    files: [
      { path: "tool/action.yml", size: bytes.length, sha256: sha256Hex(bytes) },
      { path: "LICENSE", size: license.length, sha256: sha256Hex(license) },
    ],
    licenses: ["LICENSE"],
  };
  return {
    resolved,
    manifest,
    files: [
      { path: "tool/action.yml", bytes },
      { path: "LICENSE", bytes: license },
    ] as const,
  };
};

describe("private action source kernel", () => {
  it("canonicalizes repository identity and preserves immutable provenance", async () => {
    const reference = await run(parseActionReference(`Owner/Repo/tool@${commit.toUpperCase()}`, source));
    expect(reference).toMatchObject({
      kind: "repository",
      repository: "owner/repo",
      origin: "https://github.com",
      subpath: "tool",
      commit,
    });
    if (reference.kind !== "repository") throw new Error("Expected repository");
    expect(await run(resolveFixtureReference(reference))).toMatchObject({
      provenance: "immutable-pin",
      commit,
    });
  });
  it("resolves mutable refs only with explicitly supplied trusted fixture provenance", async () => {
    const reference = await run(parseActionReference("owner/repo@v1", source));
    if (reference.kind !== "repository") throw new Error("Expected repository");
    expect(await failure(resolveFixtureReference(reference))).toMatchObject({ reason: "resolver-required" });
    const resolution = {
      origin: "https://github.com",
      repository: "owner/repo",
      requestedRef: "v1",
      commit,
      provenance: "trusted-fixture" as const,
    };
    expect(await run(resolveFixtureReference(reference, resolution))).toMatchObject({
      commit,
      provenance: "trusted-fixture",
    });
    expect(
      await failure(resolveFixtureReference(reference, { ...resolution, origin: "https://evil.example" })),
    ).toMatchObject({ reason: "origin-mismatch" });
    expect(
      await failure(resolveFixtureReference(reference, { ...resolution, repository: "different/repo" })),
    ).toMatchObject({ reason: "integrity-mismatch" });
  });
  it("rejects mutable pin-only refs and unallowed origins", async () => {
    expect(await failure(parseActionReference("owner/repo@main", source, { pinOnly: true }))).toMatchObject({
      reason: "pin-required",
    });
    expect(
      await failure(parseActionReference(`owner/repo@${commit}`, source, { allowedOrigins: [] })),
    ).toMatchObject({ reason: "policy-denied" });
  });
  it.each([
    "../outside",
    "./../outside",
    "./a/../../b",
    "./a//b",
    "./a\\b",
    "C:\\secret",
    "\\\\server\\share",
    "owner/repo@",
    "owner/repo@v1?secret=TOKEN",
    "owner/repo@v1#fragment",
    "owner/repo/%2fescape@v1",
    "owner/repo@v1%2fsecret",
    "https://TOKEN@github.com/owner/repo@main",
    "owner/repo@refs/../main",
    "owner/repo@v1\n",
    "owner/repo.git@main",
    "owner/repo.GIT@main",
    "owner/repo@.hidden",
    "owner/repo@refs/tags/example.lock",
    "docker://https://example/image",
    "docker://image@sha256:abcd",
  ])("rejects malformed input before acquisition: %s", async (text) => {
    expect(await failure(parseActionReference(text, source))).toMatchObject({
      reason: "invalid-reference",
      source,
    });
  });
  it("recognizes strict local paths and Docker digest references without materializing either", async () => {
    expect(await run(parseActionReference("./tools/action", source))).toMatchObject({
      kind: "local",
      path: "tools/action",
    });
    expect(
      await run(parseActionReference(`docker://ghcr.io/owner/image@sha256:${"b".repeat(64)}`, source)),
    ).toMatchObject({ kind: "docker", digest: `sha256:${"b".repeat(64)}` });
    expect(
      await failure(parseActionReference("docker://alpine:latest", source, { pinOnly: true })),
    ).toMatchObject({ reason: "pin-required" });
    expect(sourceCapabilities).toMatchObject({
      remoteTransport: "gated",
      archiveExtraction: "gated",
      localMaterialization: "gated",
    });
  });
  it("verifies independent expected bytes, size, canonical identity and selected metadata", async () => {
    const { resolved, manifest, files } = await fixture();
    const verified = await run(verifyFixtureSource(resolved, manifest, files));
    expect(verified.receipt).toMatchObject({
      repository: "owner/repo",
      commit,
      metadataPath: "tool/action.yml",
      licenses: ["LICENSE"],
      verification: "trusted-fixture-bytes",
    });
    expect(
      await failure(
        verifyFixtureSource(resolved, manifest, [
          { ...files[0], bytes: new Uint8Array(files[0].bytes.length) },
          files[1],
        ]),
      ),
    ).toMatchObject({ reason: "integrity-mismatch" });
    expect(
      await failure(verifyFixtureSource(resolved, { ...manifest, subpath: "other" }, files)),
    ).toMatchObject({ reason: "integrity-mismatch" });
    expect(
      await failure(
        verifyFixtureSource(resolved, manifest, [...files, { path: "../escape", bytes: new Uint8Array() }]),
      ),
    ).toMatchObject({ reason: "invalid-reference" });
  });
  it("bounds actual fixture bytes even when trusted expected size claims fewer bytes", async () => {
    const { resolved, manifest, files } = await fixture();
    expect(
      await failure(
        verifyFixtureSource(resolved, manifest, [
          { ...files[0], bytes: new Uint8Array(256 * 1024 + 1) },
          files[1],
        ]),
      ),
    ).toMatchObject({ reason: "source-limit" });
  });
  it.each(["node20", "node24", "composite", "docker"])(
    "parses %s metadata through the shared upstream parser",
    async (kind) => {
      const runs =
        kind === "composite"
          ? "  steps:\n    - run: echo PRIVATE_SCRIPT\n      shell: bash\n"
          : kind === "docker"
            ? "  image: Dockerfile\n"
            : "  main: main.js\n";
      const { resolved, manifest, files } = await fixture(
        `name: fixture\ndescription: fixture\nruns:\n  using: ${kind}\n${runs}`,
      );
      const verified = await run(verifyFixtureSource(resolved, manifest, files));
      expect(await run(loadActionMetadata(verified))).toMatchObject({ kind });
    },
  );
  it("rejects malformed metadata and invalid encoding with safe located errors", async () => {
    const { resolved, manifest, files } = await fixture("name: PRIVATE_METADATA\nruns: [\n");
    const verified = await run(verifyFixtureSource(resolved, manifest, files));
    const error = await failure(loadActionMetadata(verified));
    expect(error).toMatchObject({ reason: "metadata-invalid" });
    for (const value of [String(error), JSON.stringify(error), Bun.inspect(error)])
      expect(value).not.toContain("PRIVATE_METADATA");
    expect(error).not.toHaveProperty("cause");
  });
  it("retains private admitted authority when original manifest and payload change together", async () => {
    const { resolved, manifest, files } = await fixture();
    const verified = await run(verifyFixtureSource(resolved, manifest, files));
    const poison = new TextEncoder().encode("PRIVATE_REPLACEMENT");
    manifest.files[0] = { path: "tool/action.yml", size: poison.length, sha256: sha256Hex(poison) };
    files[0].bytes.fill(0);
    expect(verified).not.toHaveProperty("manifest");
    expect(verified).not.toHaveProperty("files");
    expect(await run(loadActionMetadata(verified))).toMatchObject({ kind: "node24" });
    const forged = { ...verified };
    expect(await failure(loadActionMetadata(forged))).toMatchObject({ reason: "integrity-mismatch" });
  });
  it("rejects accessors, prototypes and unbounded manifest data before reading authored fields", async () => {
    const { resolved, manifest, files } = await fixture();
    let reads = 0;
    const accessor = { ...manifest };
    Object.defineProperty(accessor, "files", {
      enumerable: true,
      get() {
        reads++;
        return manifest.files;
      },
    });
    expect(await failure(verifyFixtureSource(resolved, accessor, files))).toMatchObject({
      reason: "invalid-reference",
    });
    expect(reads).toBe(0);
    const prototype = Object.assign(Object.create({}), manifest);
    expect(await failure(verifyFixtureSource(resolved, prototype, files))).toMatchObject({
      reason: "invalid-reference",
    });
    expect(
      await failure(
        verifyFixtureSource(resolved, { ...manifest, licenses: ["x".repeat(128 * 1024 + 1)] }, files),
      ),
    ).toMatchObject({ reason: "invalid-reference" });
    const fileAccessor = { ...files[0] };
    Object.defineProperty(fileAccessor, "bytes", {
      enumerable: true,
      get() {
        reads++;
        return files[0].bytes;
      },
    });
    expect(await failure(verifyFixtureSource(resolved, manifest, [fileAccessor, files[1]]))).toMatchObject({
      reason: "invalid-reference",
    });
    expect(reads).toBe(0);
  });
  it("parses reusable workflow descriptions from independently verified metadata", async () => {
    const reference = await run(
      parseActionReference(`owner/repo/.github/workflows/reuse.yml@${commit}`, source),
    );
    if (reference.kind !== "repository") throw new Error("Expected repository");
    const resolved = await run(resolveFixtureReference(reference));
    const bytes = new TextEncoder().encode(
      "on: workflow_call\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo PRIVATE_SCRIPT\n",
    );
    const license = new TextEncoder().encode("MIT fixture license");
    const files = [
      { path: reference.subpath, bytes },
      { path: "LICENSE", bytes: license },
    ];
    const manifest = {
      origin: reference.origin,
      repository: reference.repository,
      commit,
      subpath: reference.subpath,
      metadataPath: reference.subpath,
      files: files.map((file) => ({
        path: file.path,
        size: file.bytes.length,
        sha256: sha256Hex(file.bytes),
      })),
      licenses: ["LICENSE"],
    };
    const verified = await run(verifyFixtureSource(resolved, manifest, files));
    expect(await run(loadActionMetadata(verified))).toMatchObject({ kind: "reusable-workflow" });
  });
  it("rejects invalid UTF-8 metadata without replacing bytes or retaining decoder causes", async () => {
    const { resolved, manifest, files } = await fixture();
    const bytes = new Uint8Array([0xff, 0xfe]);
    const license = manifest.files[1];
    if (license === undefined) throw new Error("Expected license");
    const expected = {
      ...manifest,
      files: [{ path: "tool/action.yml", size: bytes.length, sha256: sha256Hex(bytes) }, license],
    };
    const verified = await run(
      verifyFixtureSource(resolved, expected, [{ path: "tool/action.yml", bytes }, files[1]]),
    );
    const error = await failure(loadActionMetadata(verified));
    expect(error).toMatchObject({ reason: "metadata-invalid", source: { file: "tool/action.yml" } });
    expect(error).not.toHaveProperty("cause");
  });
  it("keeps unsupported Node versions outside the admitted metadata profile", async () => {
    const { resolved, manifest, files } = await fixture(
      "name: fixture\ndescription: fixture\nruns:\n  using: node16\n  main: main.js\n",
    );
    expect(
      await failure(loadActionMetadata(await run(verifyFixtureSource(resolved, manifest, files)))),
    ).toMatchObject({ reason: "metadata-invalid" });
  });
});
