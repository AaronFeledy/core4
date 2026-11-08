import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";

import { DownloadChecksumError, DownloadFetchError, ProviderUnavailableError } from "@lando/sdk/errors";
import { type DownloaderShape, OnlineAcquisition } from "@lando/sdk/services";

import { makePluginArtifactDownload } from "../src/plugin-runtime.ts";

const failingDownloader = (error: DownloadFetchError | DownloadChecksumError): DownloaderShape => ({
  id: "fake",
  capabilities: {
    schemes: ["https"],
    memoryDownload: true,
    cacheAware: true,
    offline: true,
    mirror: false,
  },
  download: () => Effect.fail(error),
});

const nftDeb = {
  url: "https://deb.debian.org/debian/pool/main/n/nftables/nftables_1.1.3-1_amd64.deb",
  expectedSha256: "a".repeat(64),
  directory: "/tmp/nft-downloads",
  filename: "nftables_1.1.3-1_amd64.deb",
  allowFileSource: false,
} as const;

const failureOf = async (effect: Effect.Effect<unknown, ProviderUnavailableError>) => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected the artifact download to fail");
  const failure = Cause.findErrorOption(exit.cause);
  if (failure._tag === "None") throw new Error("expected a typed failure");
  return failure.value;
};

describe("provider-lando artifact download failures", () => {
  test("names the artifact and download reason, keeps the cause, and appends the runtime repair command", async () => {
    // Given: the verified downloader gave up on a connection reset.
    const reset = new DownloadFetchError({
      message:
        "Couldn't download nftables_1.1.3-1_amd64.deb from https://deb.debian.org: the connection was reset (ECONNRESET). Gave up after 3 attempts.",
      urlOrigin: "https://deb.debian.org",
      attempts: 3,
      remediation: "Check the network, VPN, or proxy (HTTPS_PROXY or network.proxy).",
    });
    // When
    const failure = await failureOf(makePluginArtifactDownload(failingDownloader(reset))(nftDeb));
    // Then
    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect(failure.message).toBe(reset.message);
    expect(failure.remediation).toBe(
      `${reset.remediation} Then run \`lando setup\` to finish installing the Lando runtime.`,
    );
    expect(failure.cause).toBe(reset);
  });

  test("a checksum mismatch on a helper package is not reported as a runtime-bundle failure", async () => {
    const mismatch = new DownloadChecksumError({
      message: "SHA-256 mismatch",
      urlOrigin: "https://deb.debian.org",
      expectedSha256: "a".repeat(64),
      actualSha256: "b".repeat(64),
    });
    const failure = await failureOf(makePluginArtifactDownload(failingDownloader(mismatch))(nftDeb));
    expect(failure.message).toBe(mismatch.message);
    expect(failure.message).not.toContain("runtime bundle");
    expect(failure.remediation).toBe(
      `${mismatch.remediation} Then run \`lando setup\` to finish installing the Lando runtime.`,
    );
  });

  test("the artifact adapter preserves the caller's acquisition context", async () => {
    const reset = new DownloadFetchError({
      message: "reset",
      urlOrigin: "https://deb.debian.org",
      remediation: "Retry.",
    });
    const observed: boolean[] = [];
    const routine = makePluginArtifactDownload({
      ...failingDownloader(reset),
      download: Effect.fnUntraced(function* () {
        observed.push(yield* OnlineAcquisition);
        return yield* Effect.fail(reset);
      }),
    });
    await failureOf(routine(nftDeb));
    await failureOf(routine(nftDeb).pipe(Effect.provideService(OnlineAcquisition, true)));
    expect(observed).toEqual([false, true]);
  });
});
