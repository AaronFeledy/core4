#!/usr/bin/env bun
/** Build the helper through Lando's scoped ephemeral-container lifecycle, without needing a helper first. */
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Effect, type Scope, Stream } from "effect";

import {
  CONTAINER_HELPER_ARCHES,
  CONTAINER_HELPER_FILE,
  containerHelperGoArch,
} from "@lando/container-runtime/container-helper";
import { END_OF_ARCHIVE, TAR_BLOCK_SIZE, encodeUstarHeader, padToBlock } from "@lando/container-runtime/tar";
import { hostProviderId } from "@lando/engine/providers/host-provider";
import {
  type EphemeralRunSpec,
  type ExecChunk,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import "@lando/core/bundled-plugins";
import { makeLandoRuntime } from "@lando/core";
import { containerHelperNotices } from "../core/src/container-helper/notices.ts";
import {
  CONTAINER_HELPER_SOURCE_DIGEST_PATH,
  CONTAINER_HELPER_SOURCE_ROOT,
  containerHelperLinkerFlags,
  containerHelperSourceDigest,
} from "../core/src/container-helper/source.ts";

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const binaryNames = CONTAINER_HELPER_ARCHES.map((arch) => `linux-${arch}/${CONTAINER_HELPER_FILE}`);
const noticeNames = ["licenses/go/LICENSE", "licenses/go/PATENTS", "licenses/go/files.json"];
const artifactNames = new Set([...binaryNames, ...noticeNames]);

/** Only compiler inputs and explicit Go test data cross into the builder. */
export const containerHelperSourceArchive = async (root: string): Promise<AsyncIterable<Uint8Array>> => {
  const names: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const name = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory() && (directory !== "" || entry.name === "testdata")) await visit(name);
      else if (entry.isFile() && (directory !== "" || entry.name === "go.mod" || entry.name.endsWith(".go")))
        names.push(name);
    }
  };
  await visit("");
  // Snapshot bytes before starting the container, so only these regular files are read.
  const files = await Promise.all(
    names.sort().map(async (name) => ({ name, bytes: await readFile(join(root, name)) })),
  );
  return {
    async *[Symbol.asyncIterator]() {
      for (const { name, bytes } of files) {
        yield encodeUstarHeader(
          { name, size: bytes.length, mode: 0o644, typeflag: "0" },
          { longNames: "ustar-prefix" },
        );
        yield bytes;
        yield new Uint8Array(padToBlock(bytes.length));
      }
      yield END_OF_ARCHIVE;
    },
  };
};

export const containerHelperBuildSpec = (options: {
  readonly image: string;
  readonly test: boolean;
  readonly linkerFlags: string;
  readonly source: AsyncIterable<Uint8Array>;
}): EphemeralRunSpec => ({
  image: options.image,
  command: [
    "sh",
    "-ec",
    [
      "set -o pipefail",
      "mkdir /tmp/src; cd /tmp/src; tar -xf -",
      "mkdir -p dist/licenses/go",
      'goroot=$(go env GOROOT); cp "$goroot/LICENSE" dist/licenses/go/LICENSE',
      'if [ -f "$goroot/PATENTS" ]; then cp "$goroot/PATENTS" dist/licenses/go/PATENTS; printf \'["licenses/go/LICENSE","licenses/go/PATENTS"]\\n\' > dist/licenses/go/files.json; else printf \'["licenses/go/LICENSE"]\\n\' > dist/licenses/go/files.json; fi',
      ...(options.test ? ["go vet ./... >&2", "go test -v ./... >&2"] : []),
      ...CONTAINER_HELPER_ARCHES.map(
        (arch) =>
          `GOARCH=${containerHelperGoArch(arch)} GOOS=linux go build -trimpath -buildvcs=false -ldflags="$1" -o dist/linux-${arch}/${CONTAINER_HELPER_FILE} . >&2`,
      ),
      `tar -cf - -C dist ${[...binaryNames, "licenses/go/LICENSE", "licenses/go/files.json"].join(" ")} $(test ! -f dist/licenses/go/PATENTS || printf licenses/go/PATENTS) | base64`,
    ].join("\n"),
    "lando-container-helper-build",
    options.linkerFlags,
  ],
  stdinStream: options.source,
  captureStdout: true,
  env: { CGO_ENABLED: "0", GOCACHE: "/tmp/go-build", GOFLAGS: "-mod=mod", GOTOOLCHAIN: "local" },
  remove: true,
});

/** Decode ASCII base64 so daemon log drivers cannot corrupt binary tar bytes; a terminal status and successful scope cleanup are required before the caller publishes it. */
export const writeContainerHelperBuildArchive = (
  output: Stream.Stream<ExecChunk, ProviderError, Scope.Scope>,
  path: string,
): Effect.Effect<void, ProviderError | Error> =>
  Effect.scoped(
    Effect.gen(function* () {
      const sink = yield* Effect.acquireRelease(
        Effect.sync(() => Bun.file(path).writer()),
        (writer) =>
          Effect.promise(async () => {
            await writer.end();
          }),
      );
      let size = 0;
      let encodedSize = 0;
      let pending = "";
      const writeDecoded = async (encoded: string): Promise<void> => {
        const bytes = Buffer.from(encoded, "base64");
        if (bytes.toString("base64") !== encoded) throw new Error("Helper build emitted invalid base64.");
        size += bytes.length;
        if (size > MAX_ARCHIVE_BYTES) throw new Error("Helper build archive exceeded 64 MiB.");
        await sink.write(bytes);
      };
      let terminal: number | undefined;
      yield* Stream.runForEach(output, (chunk) =>
        Effect.tryPromise(async () => {
          if (terminal !== undefined) throw new Error("Helper build emitted data after its terminal status.");
          if ("exitCode" in chunk) terminal = chunk.exitCode;
          else if (chunk.kind === "stderr") process.stderr.write(chunk.chunk);
          else {
            encodedSize += chunk.chunk.length;
            if (encodedSize > MAX_ARCHIVE_BYTES * 1.5)
              throw new Error("Helper build base64 exceeded its size limit.");
            if (!chunk.chunk.every((byte) => byte < 128))
              throw new Error("Helper build emitted non-ASCII base64.");
            const encoded = new TextDecoder().decode(chunk.chunk);
            if (!/^[A-Za-z0-9+/=\r\n]*$/u.test(encoded))
              throw new Error("Helper build emitted invalid base64.");
            pending += encoded.replace(/[\r\n]/gu, "");
            const complete = Math.max(0, Math.floor(pending.length / 4) * 4 - 4);
            if (complete > 0) {
              const prefix = pending.slice(0, complete);
              if (prefix.includes("=")) throw new Error("Helper build emitted premature base64 padding.");
              await writeDecoded(prefix);
              pending = pending.slice(complete);
            }
          }
        }).pipe(Effect.mapError((error) => (error.cause instanceof Error ? error.cause : error))),
      );
      if (terminal !== 0)
        return yield* Effect.fail(
          new Error(`Helper build did not complete successfully (exit ${terminal ?? "unobserved"}).`),
        );
      yield* Effect.tryPromise(() => writeDecoded(pending)).pipe(
        Effect.mapError((error) => (error.cause instanceof Error ? error.cause : error)),
      );
    }),
  );

/** The builder emits only these regular files. Validate the complete tar before writing any artifacts. */
export const containerHelperBuildArtifacts = (tar: Uint8Array): ReadonlyMap<string, Uint8Array> => {
  if (tar.length > MAX_ARCHIVE_BYTES) throw new Error("Helper build archive exceeded 64 MiB.");
  const files = new Map<string, Uint8Array>();
  const text = (bytes: Uint8Array) =>
    new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\0.*$/su, "");
  const octal = (bytes: Uint8Array) => {
    const field = text(bytes).trim();
    if (!/^[0-7]+$/u.test(field)) throw new Error("Invalid helper artifact tar number.");
    return Number.parseInt(field, 8);
  };
  let offset = 0;
  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      if (tar.length - offset < TAR_BLOCK_SIZE * 2 || !tar.subarray(offset).every((byte) => byte === 0))
        throw new Error("Invalid helper artifact tar terminator.");
      for (const name of [...binaryNames, "licenses/go/LICENSE", "licenses/go/files.json"])
        if (!files.has(name)) throw new Error(`Missing helper build artifact: ${name}`);
      return files;
    }
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (octal(header.subarray(148, 156)) !== checksum)
      throw new Error("Invalid helper artifact tar checksum.");
    const name = text(header.subarray(0, 100));
    if (!artifactNames.has(name) || text(header.subarray(345, 500)) !== "" || files.has(name))
      throw new Error(`Unexpected or duplicate helper build artifact: ${name}`);
    if (header[156] !== 48 && header[156] !== 0)
      throw new Error(`Helper build artifact must be a regular file: ${name}`);
    const size = octal(header.subarray(124, 136));
    offset += TAR_BLOCK_SIZE;
    if (size === 0 || offset + size + padToBlock(size) > tar.length)
      throw new Error(`Invalid helper artifact size: ${name}`);
    files.set(name, tar.subarray(offset, offset + size));
    offset += size + padToBlock(size);
  }
  throw new Error("Truncated helper artifact tar.");
};

if (import.meta.main) {
  const digest = await containerHelperSourceDigest();
  await rm(CONTAINER_HELPER_SOURCE_DIGEST_PATH, { force: true });
  await mkdir(dirname(CONTAINER_HELPER_SOURCE_DIGEST_PATH), { recursive: true });
  const temporary = await mkdtemp(join(dirname(CONTAINER_HELPER_SOURCE_DIGEST_PATH), ".build-"));
  try {
    const landofile = Bun.YAML.parse(
      await readFile(join(CONTAINER_HELPER_SOURCE_ROOT, ".lando.yml"), "utf8"),
    ) as { services: { builder: { image: string } } };
    const image = landofile.services.builder.image;
    if (!/^golang:[^@]+@sha256:[a-f0-9]{64}$/u.test(image))
      throw new Error("Helper builder requires a digest-pinned golang image.");
    const spec = containerHelperBuildSpec({
      image,
      test: process.argv.includes("--test"),
      linkerFlags: containerHelperLinkerFlags(),
      source: await containerHelperSourceArchive(CONTAINER_HELPER_SOURCE_ROOT),
    });
    const archive = join(temporary, "artifacts.tar");
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* RuntimeProviderRegistry;
        const provider = yield* registry.select(yield* hostProviderId);
        yield* provider.pullArtifact({ ref: image, policy: "missing" });
        yield* writeContainerHelperBuildArchive(provider.runStream(spec), archive);
      }).pipe(
        Effect.provide(
          makeLandoRuntime({
            bootstrap: "provider",
            plugins: { policy: "bundled-only" },
            renderer: "plain",
            installSignalHandlers: true,
          }),
        ),
        Effect.scoped,
      ),
    );
    const staging = join(temporary, "dist");
    for (const [name, bytes] of containerHelperBuildArtifacts(await readFile(archive))) {
      const path = join(staging, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      if (binaryNames.includes(name)) await chmod(path, 0o755);
    }
    await containerHelperNotices(staging);
    const dist = resolve(CONTAINER_HELPER_SOURCE_ROOT, "dist");
    await mkdir(dist, { recursive: true });
    for (const name of [...binaryNames, ...noticeNames]) {
      const path = join(staging, name);
      if (!(await Bun.file(path).exists())) continue;
      await mkdir(dirname(join(dist, name)), { recursive: true });
      await rename(path, join(dist, name));
    }
    await writeFile(CONTAINER_HELPER_SOURCE_DIGEST_PATH, `${digest}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
