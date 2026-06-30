import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, Layer, Stream } from "effect";

import { Downloader } from "@lando/sdk/services";

import { HttpRequestError, HttpUploadError } from "@lando/sdk/errors";
import type { HttpClientCapabilities } from "@lando/sdk/schema";

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

  // Mutagen host-CLI/agent acquisition will move onto the tool-provisioning helper
  // (which provisions through Downloader); until that helper ships, file-sync-mutagen
  // keeps its own download path as the documented carve-out.
  test.todo("file-sync-mutagen host CLI + agent downloads route through Downloader");
});
