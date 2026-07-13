import { createHash } from "node:crypto";

import { Effect, Either, Fiber } from "effect";

import type { AbsolutePath, DownloadResult } from "../schema/index.ts";
import type { DownloaderShape, LandoEvent } from "../services/index.ts";
import { ContractFailure } from "./_shared.ts";

const downloaderContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `Downloader contract failed: ${assertion}`, assertion, details });

const requireDownloaderContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(downloaderContractFailure(assertion, details));

const sha256HexDigest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const downloaderErrorLeft = (value: unknown): { readonly _tag?: string; readonly reason?: string } =>
  value as { readonly _tag?: string; readonly reason?: string };

/**
 * The harness a `Downloader` implementation provides so one suite can run
 * against `DownloaderLive`, `TestDownloader`, or a plugin-contributed
 * downloader. `tempDir` is the destination directory the suite writes into;
 * `read`/`listDir` are relative to it. `serveSource` registers the bytes a
 * source URL resolves to. The optional `egress` hooks expose the byte/call
 * accounting needed to assert the egress fence (every byte flows through the
 * resolved `HttpClient`); omit them for a downloader with no observable egress.
 */
export interface DownloaderContractHarness {
  readonly name?: string;
  readonly service: DownloaderShape;
  readonly tempDir: AbsolutePath;
  readonly serveSource: (url: string, bytes: Uint8Array) => Effect.Effect<void>;
  readonly read: (filename: string) => Effect.Effect<Uint8Array | null>;
  readonly listDir: () => Effect.Effect<ReadonlyArray<string>>;
  readonly events: () => Effect.Effect<ReadonlyArray<LandoEvent>>;
  readonly egress?: {
    readonly streamCallCount: () => Effect.Effect<number>;
    readonly bytesStreamed: () => Effect.Effect<number>;
  };
}

/**
 * Run the `Downloader` contract assertions against a harness. Asserts (in
 * order): capability declaration; a verified `https://` download streams fresh
 * bytes and returns sha256+size (`fromCache:false`); an identical re-request is
 * served from the verified cache with no egress; `offline` + uncached fails
 * with `DownloadOfflineError` and issues no egress; a checksum mismatch is
 * rejected; a size mismatch is rejected; `http://` and bare `file://` sources
 * are rejected; a destination filename escaping the directory is rejected; a
 * successful file download leaves no temp file (atomic rename); an interrupted
 * file download leaves no temp file and the destination fully absent or fully
 * complete (never torn); lifecycle events are published and a secret in the URL
 * query / userinfo / caller fields never appears in any event; and (when the
 * harness exposes egress) a network miss issues exactly one stream call whose
 * byte count equals the downloaded size.
 */
export const runDownloaderContract = (
  harness: DownloaderContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const service = harness.service;
    const download = (
      request: Parameters<DownloaderShape["download"]>[0],
    ): Effect.Effect<DownloadResult, unknown> => Effect.scoped(service.download(request));
    const failWith =
      (assertion: string) =>
      (cause: unknown): ContractFailure =>
        downloaderContractFailure(assertion, cause);
    const dir = harness.tempDir;

    yield* requireDownloaderContract(
      typeof service.id === "string" && service.id.length > 0,
      "the downloader declares a non-empty id",
      service.id,
    );
    yield* requireDownloaderContract(
      Array.isArray(service.capabilities.schemes) && service.capabilities.schemes.includes("https"),
      "capabilities declare the https scheme",
      service.capabilities,
    );

    const payload = new TextEncoder().encode("contract artifact payload");
    const expectedSha256 = sha256HexDigest(payload);
    const okUrl = "https://contract.test/artifact.bin";
    yield* harness.serveSource(okUrl, payload);
    const created = yield* download({
      url: okUrl,
      destination: { kind: "file", directory: dir, filename: "artifact.bin" },
      expectedSha256,
      expectedSizeBytes: payload.length,
      callerId: "contract",
    }).pipe(Effect.mapError(failWith("a verified https download succeeds")));
    yield* requireDownloaderContract(
      created.fromCache === false &&
        created.sha256 === expectedSha256 &&
        created.sizeBytes === payload.length,
      "the first download streams fresh bytes and returns sha256+size",
      created,
    );
    const onDisk = yield* harness.read("artifact.bin");
    yield* requireDownloaderContract(
      onDisk !== null && onDisk.length === payload.length,
      "the verified file is written to the destination",
      onDisk?.length,
    );

    const cacheCallsBefore = harness.egress ? yield* harness.egress.streamCallCount() : 0;
    const cached = yield* download({
      url: okUrl,
      destination: { kind: "file", directory: dir, filename: "artifact.bin" },
      expectedSha256,
      expectedSizeBytes: payload.length,
    }).pipe(Effect.mapError(failWith("a cached re-request resolves")));
    yield* requireDownloaderContract(
      cached.fromCache === true,
      "an identical re-request is served from the verified cache",
      cached,
    );
    if (harness.egress) {
      const cacheCallsAfter = yield* harness.egress.streamCallCount();
      yield* requireDownloaderContract(cacheCallsAfter === cacheCallsBefore, "a cache hit issues no egress", {
        cacheCallsBefore,
        cacheCallsAfter,
      });
    }

    const offlineUrl = "https://contract.test/offline.bin";
    yield* harness.serveSource(offlineUrl, payload);
    const offlineCallsBefore = harness.egress ? yield* harness.egress.streamCallCount() : 0;
    const offlineResult = yield* Effect.either(
      download({
        url: offlineUrl,
        destination: { kind: "file", directory: dir, filename: "offline.bin" },
        expectedSha256,
        offline: true,
      }),
    );
    yield* requireDownloaderContract(
      Either.isLeft(offlineResult) && downloaderErrorLeft(offlineResult.left)._tag === "DownloadOfflineError",
      "offline + uncached fails with DownloadOfflineError",
      offlineResult,
    );
    if (harness.egress) {
      const offlineCallsAfter = yield* harness.egress.streamCallCount();
      yield* requireDownloaderContract(
        offlineCallsAfter === offlineCallsBefore,
        "an offline cache miss issues no egress",
        { offlineCallsBefore, offlineCallsAfter },
      );
    }

    const checksumUrl = "https://contract.test/checksum.bin";
    yield* harness.serveSource(checksumUrl, payload);
    const checksumResult = yield* Effect.either(
      download({
        url: checksumUrl,
        destination: { kind: "memory" },
        expectedSha256: "a".repeat(64),
      }),
    );
    yield* requireDownloaderContract(
      Either.isLeft(checksumResult) &&
        downloaderErrorLeft(checksumResult.left)._tag === "DownloadChecksumError",
      "a checksum mismatch is rejected with DownloadChecksumError",
      checksumResult,
    );

    const sizeUrl = "https://contract.test/size.bin";
    yield* harness.serveSource(sizeUrl, payload);
    const sizeResult = yield* Effect.either(
      download({
        url: sizeUrl,
        destination: { kind: "memory" },
        expectedSizeBytes: payload.length + 1,
      }),
    );
    yield* requireDownloaderContract(
      Either.isLeft(sizeResult) && downloaderErrorLeft(sizeResult.left)._tag === "DownloadSizeMismatchError",
      "a size mismatch is rejected with DownloadSizeMismatchError",
      sizeResult,
    );

    const schemeResult = yield* Effect.either(
      download({ url: "http://contract.test/insecure.bin", destination: { kind: "memory" } }),
    );
    yield* requireDownloaderContract(
      Either.isLeft(schemeResult) &&
        downloaderErrorLeft(schemeResult.left)._tag === "DownloadSourceForbiddenError" &&
        downloaderErrorLeft(schemeResult.left).reason === "scheme",
      "an http:// source is rejected with reason scheme",
      schemeResult,
    );

    const fileResult = yield* Effect.either(
      download({ url: "file:///tmp/contract.bin", destination: { kind: "memory" } }),
    );
    yield* requireDownloaderContract(
      Either.isLeft(fileResult) &&
        downloaderErrorLeft(fileResult.left)._tag === "DownloadSourceForbiddenError" &&
        downloaderErrorLeft(fileResult.left).reason === "file-source",
      "a bare file:// source is rejected with reason file-source",
      fileResult,
    );

    const escapeResult = yield* Effect.either(
      download({
        url: okUrl,
        destination: { kind: "file", directory: dir, filename: "../escape.bin" },
        expectedSha256,
      }),
    );
    yield* requireDownloaderContract(
      Either.isLeft(escapeResult) &&
        downloaderErrorLeft(escapeResult.left)._tag === "DownloadSourceForbiddenError" &&
        downloaderErrorLeft(escapeResult.left).reason === "destination-escape",
      "a destination filename escaping the directory is rejected",
      escapeResult,
    );

    const afterSuccess = yield* harness.listDir();
    yield* requireDownloaderContract(
      afterSuccess.includes("artifact.bin") && !afterSuccess.some((f) => f.includes(".tmp-")),
      "a successful download leaves the destination and no temp file",
      afterSuccess,
    );

    const interruptUrl = "https://contract.test/interrupt.bin";
    yield* harness.serveSource(interruptUrl, payload);
    const fiber = yield* Effect.fork(
      download({
        url: interruptUrl,
        destination: { kind: "file", directory: dir, filename: "interrupt.bin" },
        expectedSha256,
      }),
    );
    yield* Fiber.interrupt(fiber);
    const afterInterrupt = yield* harness.listDir();
    yield* requireDownloaderContract(
      !afterInterrupt.some((f) => f.includes(".tmp-")),
      "an interrupted download leaves no temp file",
      afterInterrupt,
    );
    const interruptedFile = yield* harness.read("interrupt.bin");
    yield* requireDownloaderContract(
      interruptedFile === null || interruptedFile.length === payload.length,
      "an interrupted download leaves the destination absent or complete, never torn",
      interruptedFile?.length,
    );

    const secret = "ULW-DLC-SECRET-d41d8cd9f00b2";
    const secretUrl = `https://user:${secret}@contract.test/s?token=${secret}`;
    yield* harness.serveSource(secretUrl, payload);
    yield* download({
      url: secretUrl,
      destination: { kind: "memory" },
      expectedSha256,
      callerId: `caller-${secret}`,
      redactionTokens: [secret],
    }).pipe(Effect.mapError(failWith("a secret-bearing download succeeds")));
    const events = yield* harness.events();
    yield* requireDownloaderContract(
      events.some((e) => e._tag === "pre-download") && events.some((e) => e._tag === "post-download"),
      "pre-download and post-download events are published",
      events.map((e) => e._tag),
    );
    yield* requireDownloaderContract(
      !JSON.stringify(events).includes(secret),
      "a secret in the URL query / userinfo / caller fields never appears in an event",
      { sample: events[0] },
    );

    if (harness.egress) {
      const egressUrl = "https://contract.test/egress.bin";
      yield* harness.serveSource(egressUrl, payload);
      const callsBefore = yield* harness.egress.streamCallCount();
      const bytesBefore = yield* harness.egress.bytesStreamed();
      const egressResult = yield* download({
        url: egressUrl,
        destination: { kind: "memory" },
        expectedSha256,
      }).pipe(Effect.mapError(failWith("an egress-observed download succeeds")));
      const callsAfter = yield* harness.egress.streamCallCount();
      const bytesAfter = yield* harness.egress.bytesStreamed();
      yield* requireDownloaderContract(
        callsAfter - callsBefore === 1,
        "a network miss issues exactly one egress stream call",
        { callsBefore, callsAfter },
      );
      yield* requireDownloaderContract(
        bytesAfter - bytesBefore === egressResult.sizeBytes,
        "every downloaded byte flows through the resolved HttpClient",
        { bytesBefore, bytesAfter, sizeBytes: egressResult.sizeBytes },
      );
    }
  });
