import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { describe, expect, test } from "bun:test";
import { Effect, Layer, Stream } from "effect";

import { Downloader } from "@lando/sdk/services";

import { MUTAGEN_TOOL_MANIFEST, mutagenAgentInstallPath, provisionMutagen } from "@lando/file-sync-mutagen";
import { HttpRequestError, HttpUploadError } from "@lando/sdk/errors";
import type { HttpClientCapabilities, ToolArtifactEntry } from "@lando/sdk/schema";

import { DownloaderLive } from "../../src/downloader/service.ts";
import { HttpClient, type HttpClientShape } from "../../src/http-client/service.ts";
import { makeArtifactDownload } from "../../src/providers/registry.ts";

const ACCEPTANCE_HTTP_CAPABILITIES: HttpClientCapabilities = {
  schemes: ["https", "http", "file"],
  streaming: true,
  upload: false,
  customCa: true,
  proxyAware: true,
};

const isLinuxX64 = process.platform === "linux" && process.arch === "x64";
const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

const expectBytes = (actual: Uint8Array<ArrayBufferLike>, expected: Uint8Array<ArrayBufferLike>): void => {
  expect(Buffer.compare(Buffer.from(actual), Buffer.from(expected))).toBe(0);
};

const writeAscii = (target: Uint8Array, offset: number, value: string): void => {
  target.set(new TextEncoder().encode(value), offset);
};

const makeTarGz = (
  members: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>,
): Uint8Array => {
  const block = 512;
  const chunks: Uint8Array[] = [];
  for (const member of members) {
    const header = new Uint8Array(block);
    header.set(new TextEncoder().encode(member.name).subarray(0, 100), 0);
    writeAscii(header, 100, "0000644\0");
    writeAscii(header, 108, "0000000\0");
    writeAscii(header, 116, "0000000\0");
    writeAscii(header, 124, `${member.bytes.length.toString(8).padStart(11, "0")} `);
    writeAscii(header, 136, "00000000000 ");
    header[156] = 0x30;
    writeAscii(header, 257, "ustar\0");
    header[263] = 0x30;
    header[264] = 0x30;
    for (let i = 148; i < 156; i++) header[i] = 0x20;
    const sum = header.reduce((total, byte) => total + byte, 0);
    writeAscii(header, 148, `${sum.toString(8).padStart(6, "0")}\0 `);
    chunks.push(header);
    const padded = new Uint8Array(Math.ceil(member.bytes.length / block) * block);
    padded.set(member.bytes);
    chunks.push(padded);
  }
  chunks.push(new Uint8Array(block * 2));
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return new Uint8Array(gzipSync(Buffer.from(output)));
};

const withTempDir = async <A>(fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-dl-acceptance-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("Downloader acceptance (linux-x64): runtime-bundle routes through Downloader", () => {
  test.skipIf(!isLinuxX64)(
    "the provider runtime-bundle download flows every byte through the resolved HttpClient",
    async () => {
      await withTempDir(async (dir) => {
        const bundle = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
        const url = "https://runtime-bundle.test/lando-runtime.zip";
        let streamCalls = 0;
        let bytesStreamed = 0;
        const http: HttpClientShape = {
          id: "acceptance-http",
          capabilities: ACCEPTANCE_HTTP_CAPABILITIES,
          request: (request) =>
            Effect.fail(
              new HttpRequestError({ message: "request unsupported in fake", urlOrigin: request.url }),
            ),
          stream: (request) =>
            Effect.suspend(() => {
              streamCalls += 1;
              if (request.url !== url) {
                return Effect.fail(
                  new HttpRequestError({ message: "miss", urlOrigin: request.url, status: 404 }),
                );
              }
              bytesStreamed += bundle.length;
              return Effect.succeed({
                status: 200,
                headers: [],
                body: Stream.fromIterable([bundle]),
              });
            }),
          upload: (request) =>
            Effect.fail(new HttpUploadError({ message: "upload unsupported", urlOrigin: request.url })),
        };

        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const downloader = yield* Downloader;
            const artifactDownload = makeArtifactDownload(downloader);
            return yield* artifactDownload({
              url,
              expectedSha256: sha256Hex(bundle),
              directory: dir,
              filename: "lando-runtime.zip",
              allowFileSource: false,
            });
          }).pipe(Effect.provide(DownloaderLive.pipe(Layer.provide(Layer.succeed(HttpClient, http))))),
        );

        expect(result.sha256).toBe(sha256Hex(bundle));
        expect(result.bytes).toEqual(bundle);
        expect(streamCalls).toBe(1);
        expect(bytesStreamed).toBe(bundle.length);

        const onDisk = new Uint8Array(await readFile(join(dir, "lando-runtime.zip")));
        expect(onDisk).toEqual(bundle);
      });
    },
  );

  test("installer script downloads remain outside runtime Downloader scope", async () => {
    const installSh = await readFile(join(REPO_ROOT, "scripts/install.sh"), "utf8");
    const installPs1 = await readFile(join(REPO_ROOT, "scripts/install.ps1"), "utf8");

    expect(installSh).not.toContain("Downloader");
    expect(installPs1).not.toContain("Downloader");
  });

  test.skipIf(!isLinuxX64)(
    "file-sync-mutagen host CLI + agent downloads route through Downloader",
    async () => {
      await withTempDir(async (dir) => {
        const url = "https://mutagen.test/mutagen_linux_amd64_v0.18.1.tar.gz";
        const hostBin = text("#!/bin/sh\necho mutagen\n");
        const agentAmd64 = text("agent-amd64");
        const agentArm64 = text("agent-arm64");
        const agentArm = text("agent-arm");
        const nestedAgents = makeTarGz([
          { name: "linux_amd64", bytes: agentAmd64 },
          { name: "linux_arm64", bytes: agentArm64 },
          { name: "linux_arm", bytes: agentArm },
        ]);
        const archive = makeTarGz([
          { name: "mutagen", bytes: hostBin },
          { name: "mutagen-agents.tar.gz", bytes: nestedAgents },
        ]);
        const archiveSha = sha256Hex(archive);
        const artifacts = MUTAGEN_TOOL_MANIFEST.artifacts as Record<string, ToolArtifactEntry>;
        const keys = [
          "linux-x64/cli",
          "linux-x64/agent/linux-amd64",
          "linux-x64/agent/linux-arm64",
          "linux-x64/agent/linux-armv7",
        ];
        const originals = keys.map((key) => [key, artifacts[key]] as const);
        artifacts["linux-x64/cli"] = {
          url,
          sha256: archiveSha,
          sizeBytes: archive.byteLength,
          archive: "tar.gz",
          member: "mutagen",
          installName: "mutagen",
        };
        artifacts["linux-x64/agent/linux-amd64"] = {
          url,
          sha256: archiveSha,
          sizeBytes: archive.byteLength,
          archive: "tar.gz",
          member: "mutagen-agents.tar.gz/linux_amd64",
          installName: "mutagen-agents/mutagen-agent-linux-amd64",
        };
        artifacts["linux-x64/agent/linux-arm64"] = {
          url,
          sha256: archiveSha,
          sizeBytes: archive.byteLength,
          archive: "tar.gz",
          member: "mutagen-agents.tar.gz/linux_arm64",
          installName: "mutagen-agents/mutagen-agent-linux-arm64",
        };
        artifacts["linux-x64/agent/linux-armv7"] = {
          url,
          sha256: archiveSha,
          sizeBytes: archive.byteLength,
          archive: "tar.gz",
          member: "mutagen-agents.tar.gz/linux_arm",
          installName: "mutagen-agents/mutagen-agent-linux-armv7",
        };

        let streamCalls = 0;
        const http: HttpClientShape = {
          id: "mutagen-acceptance-http",
          capabilities: ACCEPTANCE_HTTP_CAPABILITIES,
          request: (request) =>
            Effect.fail(new HttpRequestError({ message: "request unsupported", urlOrigin: request.url })),
          stream: (request) =>
            Effect.suspend(() => {
              streamCalls += 1;
              if (request.url !== url) {
                return Effect.fail(
                  new HttpRequestError({ message: "miss", urlOrigin: request.url, status: 404 }),
                );
              }
              return Effect.succeed({ status: 200, headers: [], body: Stream.fromIterable([archive]) });
            }),
          upload: (request) =>
            Effect.fail(new HttpUploadError({ message: "upload unsupported", urlOrigin: request.url })),
        };

        try {
          await Effect.runPromise(
            Effect.scoped(
              provisionMutagen({
                binDir: join(dir, "bin"),
                toolDownloadsDir: join(dir, "tool-downloads", "mutagen"),
                platform: "linux",
                arch: "x64",
              }),
            ).pipe(Effect.provide(DownloaderLive.pipe(Layer.provide(Layer.succeed(HttpClient, http))))),
          );

          expect(streamCalls).toBe(1);
          expectBytes(await readFile(join(dir, "bin", "mutagen")), hostBin);
          expectBytes(await readFile(mutagenAgentInstallPath(join(dir, "bin"), "linux-amd64")), agentAmd64);
        } finally {
          for (const [key, entry] of originals) {
            if (entry === undefined) delete artifacts[key];
            else artifacts[key] = entry;
          }
        }
      });
    },
  );
});
