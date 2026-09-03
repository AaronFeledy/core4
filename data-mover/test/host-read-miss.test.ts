import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Schema, Stream } from "effect";

import { DataMoverLive } from "@lando/data-mover/service";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService } from "@lando/redaction/service";
import { DataTransferError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { DataMover, EventService, PathsService, RuntimeProvider } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { StateStoreLive } from "@lando/state-store/service";

const absolute = (path: string) => Schema.decodeUnknownSync(AbsolutePath)(path);

const silentEvents = Layer.succeed(EventService, {
  publish: () => Effect.void,
  subscribe: () => Stream.empty,
  subscribeQueue: Effect.never,
  waitFor: () => Effect.never,
  waitForAny: () => Effect.never,
  query: () => Effect.succeed([]),
});

const passthroughRedaction = Layer.succeed(RedactionService, {
  forProfile: () =>
    Effect.succeed({
      redactString: (input: string) => input,
      redactValue: (input: unknown) => input,
    }),
});

describe("byteStreamFromHost missing files", () => {
  test("fails with a host-file-not-found DataTransferError on ENOENT", async () => {
    const dir = await mkdtemp(resolve(process.cwd(), ".tmp-data-mover-host-read-"));
    const missing = join(dir, "missing.bin");
    const dest = join(dir, "out.tar");
    try {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const dataMover = yield* DataMover;
            yield* dataMover.transfer({
              from: { _tag: "hostPath", path: absolute(missing) },
              to: { _tag: "hostArchive", path: absolute(dest), format: "tar" },
              overwrite: true,
            });
          }),
        ).pipe(
          Effect.provideService(RuntimeProvider, TestRuntimeProvider),
          Effect.provide(
            DataMoverLive.pipe(
              Layer.provide(
                Layer.mergeAll(
                  StateStoreLive,
                  Layer.succeed(PathsService, makeLandoPaths()),
                  Layer.succeed(RuntimeProvider, TestRuntimeProvider),
                  silentEvents,
                  passthroughRedaction,
                ),
              ),
            ),
          ),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) throw new Error("expected failure");
      const error = Cause.failureOption(exit.cause);
      const value = error._tag === "Some" ? error.value : undefined;
      expect(value).toBeInstanceOf(DataTransferError);
      if (value instanceof DataTransferError) {
        expect(value.operation).toBe("read-host");
        expect(value.message).toContain("Host data file not found");
        expect(value.fromEndpoint).toContain(missing);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
