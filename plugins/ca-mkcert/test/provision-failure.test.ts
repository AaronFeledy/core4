import { expect, test } from "bun:test";
import { Effect } from "effect";

import { DownloadFetchError } from "@lando/sdk/errors";
import { Downloader } from "@lando/sdk/services";
import { makeMkcertCertificateAuthority } from "../src/ca.ts";
import { failure, makeCaHarness, makeFakeMkcertRunner } from "./_fixtures.ts";

test("mkcert provisioning preserves download advice and appends the setup repair command", async () => {
  const harness = await makeCaHarness();
  try {
    const cause = new DownloadFetchError({
      message: "Couldn't download mkcert from https://artifacts.test: the connection was reset.",
      urlOrigin: "https://artifacts.test",
      reason: "connection-reset",
      remediation: "Check the network, VPN, or proxy (HTTPS_PROXY or network.proxy).",
    });
    const ca = makeMkcertCertificateAuthority({
      ...harness,
      platform: "linux",
      arch: "x64",
      processRunner: makeFakeMkcertRunner({ caRoot: harness.caRoot }).service,
      privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
      downloader: Downloader.of({
        id: "provision-failure",
        capabilities: {
          schemes: ["https"],
          memoryDownload: false,
          cacheAware: false,
          offline: false,
          mirror: false,
        },
        download: () => Effect.fail(cause),
      }),
    });

    const error = failure(await Effect.runPromiseExit(ca.setup({ force: false })));

    expect(error.message).toBe(cause.message);
    expect(error.remediation).toBe(`${cause.remediation} Then run \`lando setup\`.`);
    expect(error.cause).toBe(cause);
  } finally {
    await harness.cleanup();
  }
});
