import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { DownloadFetchError, FileSyncStartError } from "@lando/sdk/errors";
import { Downloader, FileSyncEngine, PathsService } from "@lando/sdk/services";
import { layer } from "../src/index.ts";

test("Mutagen provisioning preserves download advice and appends the setup repair command", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-mutagen-failure-"));
  try {
    const cause = new DownloadFetchError({
      message: "Couldn't download mutagen.tar.gz from https://artifacts.test: the connection was reset.",
      urlOrigin: "https://artifacts.test",
      reason: "connection-reset",
      remediation: "Check the network, VPN, or proxy (HTTPS_PROXY or network.proxy).",
    });
    const paths = makeLandoPaths({
      userConfRoot: join(root, "conf"),
      userDataRoot: join(root, "data"),
      userCacheRoot: join(root, "cache"),
      systemPluginRoot: join(root, "system"),
    });
    const downloader = Downloader.of({
      id: "provision-failure",
      capabilities: {
        schemes: ["https"],
        memoryDownload: false,
        cacheAware: false,
        offline: false,
        mirror: false,
      },
      download: () => Effect.fail(cause),
    });

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* FileSyncEngine;
          yield* engine.setup({ force: false });
        }),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(PathsService, paths),
        Effect.provideService(Downloader, downloader),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      expect(error).toBeInstanceOf(FileSyncStartError);
      if (!(error instanceof FileSyncStartError)) throw error;
      expect(error.message).toBe(cause.message);
      expect(error.remediation).toBe(`${cause.remediation} Then run \`lando setup\`.`);
      expect(error.cause).toBe(cause);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
