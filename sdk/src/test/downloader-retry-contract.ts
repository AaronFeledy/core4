import { Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";

import { OnlineAcquisition } from "../services/downloader.ts";
import { ContractFailure } from "./_shared.ts";
import type { DownloaderContractHarness } from "./downloader-contract.ts";

const requireContract = (condition: boolean, assertion: string, details: unknown) =>
  condition
    ? Effect.void
    : Effect.fail(
        new ContractFailure({ message: `Downloader contract failed: ${assertion}`, assertion, details }),
      );

export const runDownloaderRetryContract = (harness: DownloaderContractHarness) =>
  Effect.gen(function* () {
    const failures = harness.failures;
    const bytes = new TextEncoder().encode("retry contract payload");
    const retryUrl = "https://contract.test/retry.bin";
    yield* harness.serveSource(retryUrl, bytes);
    yield* failures.reset(retryUrl, 1);
    const before = yield* harness.events();
    const retry = yield* Effect.forkChild(
      Effect.scoped(harness.service.download({ url: retryUrl, destination: { kind: "memory" } })).pipe(
        Effect.provideService(OnlineAcquisition, true),
      ),
    );
    // A downloader that never retries finishes before announcing a retry; don't wait forever for the notice.
    const first = yield* Effect.raceFirst(
      failures.nextRetry.pipe(Effect.as("retrying" as const)),
      Fiber.await(retry).pipe(Effect.as("finished" as const)),
    );
    if (first === "retrying") yield* TestClock.adjust("1 second");
    const outcome = yield* Fiber.await(retry);
    yield* requireContract(
      first === "retrying" && outcome._tag === "Success" && outcome.value.sizeBytes === bytes.length,
      "acquisition retries a transient failure then succeeds",
      outcome,
    );
    const events = (yield* harness.events()).slice(before.length);
    const posts = events.filter((event) => event._tag === "post-download");
    yield* requireContract(
      events.filter((event) => event._tag === "pre-download").length === 1 &&
        posts.length === 1 &&
        posts[0]?.attempts === 2,
      "retry publishes one pre/post pair with attempts 2",
      events,
    );

    const routineUrl = "https://contract.test/routine.bin";
    yield* harness.serveSource(routineUrl, bytes);
    yield* failures.reset(routineUrl, 1);
    const routine = yield* Effect.result(
      Effect.scoped(harness.service.download({ url: routineUrl, destination: { kind: "memory" } })).pipe(
        Effect.provideService(OnlineAcquisition, false),
      ),
    );
    yield* requireContract(
      Result.isFailure(routine) &&
        routine.failure._tag === "DownloadFetchError" &&
        routine.failure.reason === "connection-reset" &&
        routine.failure.attempts === 1,
      "routine download fails once with connection-reset",
      routine,
    );

    const missingUrl = "https://contract.test/missing.bin";
    yield* failures.status(missingUrl, 404);
    const missing = yield* Effect.result(
      Effect.scoped(harness.service.download({ url: missingUrl, destination: { kind: "memory" } })).pipe(
        Effect.provideService(OnlineAcquisition, true),
      ),
    );
    yield* requireContract(
      Result.isFailure(missing) &&
        missing.failure._tag === "DownloadFetchError" &&
        missing.failure.reason === "http-status" &&
        missing.failure.status === 404 &&
        missing.failure.attempts === 1,
      "HTTP 404 is classified and never retried",
      missing,
    );
  }).pipe(Effect.provide(TestClock.layer()));
