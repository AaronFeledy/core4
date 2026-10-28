import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { END_OF_ARCHIVE, encodeUstarHeader, padToBlock } from "@lando/container-runtime/tar";
import type { ExecChunk } from "@lando/sdk/services";
import { Effect, Stream } from "effect";
import {
  containerHelperBuildArtifacts,
  containerHelperBuildSpec,
  containerHelperSourceArchive,
  writeContainerHelperBuildArchive,
} from "../../../scripts/build-container-helper.ts";

const encoder = new TextEncoder();
const entries = [
  ["linux-x64/lando-container-helper", new Uint8Array([0, 255, 128, 10])],
  ["linux-arm64/lando-container-helper", encoder.encode("arm64")],
  ["licenses/go/LICENSE", encoder.encode("license")],
  ["licenses/go/files.json", encoder.encode('["licenses/go/LICENSE"]')],
] as const;
const archive = (files: ReadonlyArray<readonly [string, Uint8Array]>, typeflag: "0" | "2" = "0") =>
  Buffer.concat([
    ...files.flatMap(([name, bytes]) => [
      encodeUstarHeader({ name, size: bytes.length, mode: 0o755, typeflag }),
      bytes,
      new Uint8Array(padToBlock(bytes.length)),
    ]),
    END_OF_ARCHIVE,
  ]);

const withRoot = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-helper-bootstrap-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("bootstrap source archive includes Go tests and testdata while excluding outputs, caches and symlinks", () =>
  withRoot(async (root) => {
    await mkdir(join(root, "testdata"));
    await mkdir(join(root, "dist"));
    await mkdir(join(root, ".cache"));
    for (const name of [
      "go.mod",
      "main.go",
      "main_test.go",
      "testdata/request.json",
      "dist/output",
      ".cache/private",
      ".env",
      "credentials",
    ])
      await writeFile(join(root, name), name);
    await symlink(join(root, ".env"), join(root, "linked.go"));
    const chunks: Uint8Array[] = [];
    for await (const chunk of await containerHelperSourceArchive(root)) chunks.push(chunk);
    const files = await new Bun.Archive(Buffer.concat(chunks)).files();
    expect([...files.keys()].sort()).toEqual(["go.mod", "main.go", "main_test.go", "testdata/request.json"]);
  }));

test("bootstrap uses one ephemeral image process with tar-only stdout and no host resource mounts or forwarded environment", () => {
  const source = {
    async *[Symbol.asyncIterator]() {
      yield END_OF_ARCHIVE;
    },
  };
  const spec = containerHelperBuildSpec({
    image: "golang:pinned",
    test: true,
    linkerFlags: '-X main.value=a"b',
    source,
  });
  expect(spec.stdinStream).toBe(source);
  expect(spec.mounts).toBeUndefined();
  expect(spec.remove).toBe(true);
  expect(spec.env).toEqual({
    CGO_ENABLED: "0",
    GOCACHE: "/tmp/go-build",
    GOFLAGS: "-mod=mod",
    GOTOOLCHAIN: "local",
  });
  expect(spec.command[2]).toContain("go vet ./... >&2\ngo test -v ./... >&2");
  expect(spec.command[2]).toContain('-ldflags="$1"');
  expect(spec.command.at(-1)).toBe('-X main.value=a"b');
  expect(spec.command[2]).toContain("tar -cf - -C dist");
  expect(spec.command[2]).toContain("| base64");
});

test("bootstrap writes binary chunks exactly and joins provider cleanup before returning", () =>
  withRoot(async (root) => {
    const bytes = archive(entries);
    const encoded = encoder.encode(bytes.toString("base64"));
    let cleaned = false;
    const output = Stream.scoped(
      Stream.fromEffect(
        Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            cleaned = true;
          }),
        ),
      ),
    ).pipe(
      Stream.flatMap(() =>
        Stream.fromIterable<ExecChunk>([
          { kind: "stdout", chunk: encoded.subarray(0, 513) },
          { kind: "stdout", chunk: encoded.subarray(513) },
          { exitCode: 0 },
        ]),
      ),
    );
    const path = join(root, "artifact.tar");
    await Effect.runPromise(writeContainerHelperBuildArchive(output, path));
    expect(cleaned).toBe(true);
    expect(await readFile(path)).toEqual(bytes);
    expect(containerHelperBuildArtifacts(await readFile(path)).get(entries[0][0])).toEqual(entries[0][1]);
  }));

test.each([undefined, 1])("bootstrap rejects unproven or failing terminal status %s", (exitCode) =>
  withRoot(async (root) => {
    const chunks: ExecChunk[] = [
      { kind: "stdout", chunk: encoder.encode(archive(entries).toString("base64")) },
    ];
    if (exitCode !== undefined) chunks.push({ exitCode });
    await expect(
      Effect.runPromise(
        writeContainerHelperBuildArchive(Stream.fromIterable(chunks), join(root, "artifact.tar")),
      ),
    ).rejects.toThrow("did not complete successfully");
  }),
);

test.each([new Uint8Array([255]), encoder.encode("YW=J"), encoder.encode("YR==")])(
  "bootstrap rejects invalid or noncanonical base64 %s",
  (bytes) =>
    withRoot(async (root) => {
      await expect(
        Effect.runPromise(
          writeContainerHelperBuildArchive(
            Stream.fromIterable<ExecChunk>([{ kind: "stdout", chunk: bytes }, { exitCode: 0 }]),
            join(root, "artifact.tar"),
          ),
        ),
      ).rejects.toThrow("base64");
    }),
);

test("bootstrap preserves a provider cleanup failure after command success", () =>
  withRoot(async (root) => {
    const output = Stream.scoped(
      Stream.fromEffect(Effect.acquireRelease(Effect.void, () => Effect.die(new Error("remove failed")))),
    ).pipe(
      Stream.flatMap(() =>
        Stream.fromIterable<ExecChunk>([
          { kind: "stdout", chunk: encoder.encode(archive(entries).toString("base64")) },
          { exitCode: 0 },
        ]),
      ),
    );
    await expect(
      Effect.runPromise(writeContainerHelperBuildArchive(output, join(root, "artifact.tar"))),
    ).rejects.toThrow("remove failed");
  }));

test.each(["../escape", "/absolute", "licenses/go/extra", "linux-x64/../escape"])(
  "bootstrap rejects unexpected archive path %s",
  (name) => {
    expect(() => containerHelperBuildArtifacts(archive([[name, encoder.encode("bad")], ...entries]))).toThrow(
      "Unexpected",
    );
  },
);

test("bootstrap rejects symlinks, duplicate files, corrupt headers, truncation and missing binaries", () => {
  expect(() => containerHelperBuildArtifacts(archive(entries, "2"))).toThrow("regular file");
  expect(() => containerHelperBuildArtifacts(archive([...entries, entries[0]]))).toThrow("duplicate");
  const corrupt = archive(entries);
  corrupt[0] = 33;
  expect(() => containerHelperBuildArtifacts(corrupt)).toThrow("checksum");
  expect(() => containerHelperBuildArtifacts(archive(entries).subarray(0, 600))).toThrow("size");
  expect(() => containerHelperBuildArtifacts(archive(entries.slice(1)))).toThrow("Missing");
});
