import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, Effect, Exit, Layer } from "effect";

import { ProviderBundleChecksumError } from "@lando/provider-lando";
import { Downloader } from "@lando/sdk/services";

import { DownloaderLive } from "../../src/downloader/service.ts";
import { makeHttpClientLive } from "../../src/http-client/live.ts";
import { NetworkTrust, type ResolvedNetworkTrust } from "../../src/http-client/network-trust.ts";
import { makeArtifactDownload } from "../../src/providers/registry.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-artifact-download-"));
  tempDirs.push(dir);
  return dir;
};

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const CA_PEM = "-----BEGIN CERTIFICATE-----\nMOCKCA\n-----END CERTIFICATE-----";
const BUNDLE = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);

const captureFetch = (
  body: Uint8Array,
): { fetchImpl: typeof fetch; init: () => BunFetchRequestInit | undefined } => {
  let captured: BunFetchRequestInit | undefined;
  const fetchImpl = ((_input: unknown, requestInit?: BunFetchRequestInit) => {
    captured = requestInit;
    return Promise.resolve(new Response(body, { status: 200 }));
  }) as typeof fetch;
  return { fetchImpl, init: () => captured };
};

const artifactDownloadEffect = (fetchImpl: typeof fetch, directory: string, trust?: ResolvedNetworkTrust) =>
  Effect.gen(function* () {
    const downloader = yield* Downloader;
    const artifactDownload = makeArtifactDownload(downloader);
    const effect = artifactDownload({
      url: "https://example.test/lando-runtime.zip",
      expectedSha256: sha256Hex(BUNDLE),
      directory,
      filename: "bundle.zip",
      allowFileSource: false,
    });
    return yield* trust === undefined ? effect : effect.pipe(Effect.provideService(NetworkTrust, trust));
  }).pipe(Effect.provide(DownloaderLive.pipe(Layer.provide(makeHttpClientLive(fetchImpl)))));

const runArtifactDownload = (fetchImpl: typeof fetch, directory: string, trust?: ResolvedNetworkTrust) =>
  Effect.runPromise(artifactDownloadEffect(fetchImpl, directory, trust));

const expectFailure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) {
    throw new Error("expected effect to fail");
  }
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag !== "Some") {
    throw new Error(`expected a typed failure, got ${JSON.stringify(exit.cause)}`);
  }
  return failure.value;
};

describe("makeArtifactDownload", () => {
  test("downloads + verifies through the core Downloader and applies ambient network trust", async () => {
    const directory = await makeTempDir();
    const capture = captureFetch(BUNDLE);

    const result = await runArtifactDownload(capture.fetchImpl, directory, {
      proxy: { http: "http://proxy:3128", https: "http://proxy:3128", noProxy: [] },
      caPems: [CA_PEM],
    });

    expect(result.bytes).toEqual(BUNDLE);
    expect(result.sha256).toBe(sha256Hex(BUNDLE));
    expect(result.path).toBe(join(directory, "bundle.zip"));
    expect(capture.init()?.proxy).toBe("http://proxy:3128");
    expect(capture.init()?.tls).toEqual({ ca: [CA_PEM] });
  });

  test("leaves the fetch init free of proxy/tls when no network trust is provided", async () => {
    const directory = await makeTempDir();
    const capture = captureFetch(BUNDLE);

    const result = await runArtifactDownload(capture.fetchImpl, directory);

    expect(result.bytes).toEqual(BUNDLE);
    expect(capture.init()?.proxy).toBeUndefined();
    expect(capture.init()?.tls).toBeUndefined();
  });

  test("preserves provider-lando checksum remediation when the downloaded bytes mismatch", async () => {
    const directory = await makeTempDir();
    const capture = captureFetch(new Uint8Array([1, 1, 1]));

    const failure = expectFailure(
      await Effect.runPromiseExit(artifactDownloadEffect(capture.fetchImpl, directory)),
    );
    expect(failure).toBeInstanceOf(ProviderBundleChecksumError);
    expect((failure as ProviderBundleChecksumError).remediation).toContain("pinned SHA-256");
  });
});
