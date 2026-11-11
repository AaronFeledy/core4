import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Cause, Deferred, Effect, Exit, Fiber, Option } from "effect";

import { DownloadFetchError } from "@lando/sdk/errors";
import { Downloader, OnlineAcquisition } from "@lando/sdk/services";
import { defaultFetchManifestBytes, fetchBytes } from "../../src/update/manifest.ts";

test.each([true, false])("the update manifest bridge carries acquisition context (%s)", async (enabled) => {
  const observed: boolean[] = [];
  const payload = new TextEncoder().encode("manifest bytes");
  const downloader = Downloader.of({
    id: "manifest-context",
    capabilities: {
      schemes: ["https"],
      memoryDownload: false,
      cacheAware: false,
      offline: false,
      mirror: false,
    },
    download: Effect.fnUntraced(function* (request) {
      observed.push(yield* OnlineAcquisition);
      if (request.destination.kind !== "file") return yield* Effect.die("Expected file destination");
      const path = join(request.destination.directory, request.destination.filename);
      yield* Effect.promise(() => writeFile(path, payload));
      return {
        url: request.url,
        kind: "file" as const,
        path,
        sha256: "unused-by-transport",
        sizeBytes: payload.length,
        fromCache: false,
      };
    }),
  });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      return yield* Effect.promise(() =>
        defaultFetchManifestBytes("https://update.test/manifest.json", downloader, context),
      );
    }).pipe(Effect.provideService(OnlineAcquisition, enabled)),
  );
  expect(result).toEqual(payload);
  expect(observed).toEqual([enabled]);
});

test("interrupting an update fetch interrupts the download and runs its finalizer", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finalized = yield* Deferred.make<Exit.Exit<never, never>>();
      const downloader = Downloader.of({
        id: "manifest-interrupt",
        capabilities: {
          schemes: ["https"],
          memoryDownload: false,
          cacheAware: false,
          offline: false,
          mirror: false,
        },
        download: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onExit((exit) => Deferred.succeed(finalized, exit)),
          ),
      });
      const fiber = yield* fetchBytes(
        (url, signal) => defaultFetchManifestBytes(url, downloader, undefined, signal),
        "https://update.test/manifest.json",
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);

      yield* Fiber.interrupt(fiber);
      const exit = yield* Deferred.await(finalized).pipe(Effect.timeout("2 seconds"));

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }),
  );
});

test.each([
  {
    reason: "trust",
    trustCause: "certificate-invalid",
    message: "The origin certificate has expired.",
    remediation: "Ask the origin operator to renew the certificate.",
  },
  {
    reason: "connection-reset",
    message: "The connection was reset (ECONNRESET).",
    remediation: "Check the network, VPN, or proxy (HTTPS_PROXY or network.proxy).",
  },
] as const)("update preserves downloader failure text for $reason", async (failure) => {
  const cause = new DownloadFetchError({ ...failure, urlOrigin: "https://update.test" });
  const downloader = Downloader.of({
    id: "manifest-failure",
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
    fetchBytes(
      (url, signal) => defaultFetchManifestBytes(url, downloader, undefined, signal),
      "https://update.test/manifest.json",
    ),
  );

  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
    expect(error.message).toBe(cause.message);
    expect(error.remediation).toBe(`${cause.remediation} Then run \`lando update\` again.`);
    expect(error.cause).toBe(cause);
  }
});

test("update keeps generic advice for an ordinary fetcher rejection", async () => {
  const cause = new Error("fetch failed");
  const url = "https://update.test/manifest.json";
  const exit = await Effect.runPromiseExit(fetchBytes(() => Promise.reject(cause), url));

  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
      message: `Failed to download ${url} for \`lando update\`.`,
      remediation: `Check network access to ${url}, then retry \`lando update\`.`,
      cause,
    });
  }
});
