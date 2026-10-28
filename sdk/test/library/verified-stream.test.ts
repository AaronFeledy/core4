import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, spyOn, test } from "bun:test";
import { Cause, Deferred, Effect, Fiber, Stream } from "effect";

import {
  VerifiedStreamError,
  collectVerifiedStream,
  persistVerifiedStream,
} from "@lando/sdk/verified-stream";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("verified stream size ceilings", () => {
  for (const mode of ["collect", "persist"] as const) {
    test(`${mode} stops at the first chunk exceeding the expected size`, async () => {
      const dir = await fs.mkdtemp(join(tmpdir(), "lando-size-ceiling-"));
      const target = join(dir, "artifact.bin");
      await fs.writeFile(target, "original");
      let pulls = 0;
      let finalized = 0;
      const body = Stream.fromEffectRepeat(
        Effect.sync(() => {
          pulls += 1;
          return bytes("ab");
        }),
      ).pipe(
        Stream.take(3),
        Stream.ensuring(
          Effect.sync(() => {
            finalized += 1;
          }),
        ),
      );
      const written: Array<Uint8Array> = [];
      const originalOpen = fs.open;
      const open = spyOn(fs, "open").mockImplementation(async (path, flags, permissions) => {
        const handle = await originalOpen(path, flags, permissions);
        if (path === `${target}.tmp-ceiling`) {
          const write = handle.write.bind(handle);
          handle.write = ((buffer: Uint8Array) => {
            written.push(new Uint8Array(buffer));
            return write(buffer);
          }) as typeof handle.write;
        }
        return handle;
      });
      try {
        const error = await Effect.runPromise(
          Effect.scoped(
            mode === "collect"
              ? collectVerifiedStream({ body, expectedSizeBytes: 3 })
              : persistVerifiedStream({
                  body,
                  destinationPath: target,
                  expectedSizeBytes: 3,
                  randomId: () => "ceiling",
                }),
          ).pipe(Effect.flip),
        );
        expect(error).toBeInstanceOf(VerifiedStreamError);
        expect(error.reason).toBe("size");
        expect(error.expectedSizeBytes).toBe(3);
        expect(error.actualSizeBytes).toBe(4);
        expect(pulls).toBe(2);
        expect(finalized).toBe(1);
        if (mode === "persist") expect(written).toEqual([bytes("ab")]);
        expect(await fs.readFile(target, "utf8")).toBe("original");
        expect(await fs.readdir(dir)).toEqual(["artifact.bin"]);
      } finally {
        open.mockRestore();
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    for (const expectedSizeBytes of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      test(`${mode} rejects invalid expected size ${expectedSizeBytes} before pulling or opening`, async () => {
        const dir = await fs.mkdtemp(join(tmpdir(), "lando-invalid-size-"));
        const target = join(dir, "artifact.bin");
        let pulls = 0;
        const body = Stream.fromEffect(
          Effect.sync(() => {
            pulls += 1;
            return bytes("payload");
          }),
        );
        const open = spyOn(fs, "open");
        try {
          const error = await Effect.runPromise(
            Effect.scoped(
              mode === "collect"
                ? collectVerifiedStream({ body, expectedSizeBytes })
                : persistVerifiedStream({ body, expectedSizeBytes, destinationPath: target }),
            ).pipe(Effect.flip),
          );
          expect(error.reason).toBe("size");
          expect(error.actualSizeBytes).toBe(0);
          expect(pulls).toBe(0);
          expect(open).not.toHaveBeenCalled();
          expect(await fs.readdir(dir)).toEqual([]);
        } finally {
          open.mockRestore();
          await fs.rm(dir, { recursive: true, force: true });
        }
      });
    }

    test(`${mode} interruption releases the body and leaves no temporary file`, async () => {
      const dir = await fs.mkdtemp(join(tmpdir(), "lando-interrupt-stream-"));
      const target = join(dir, "artifact.bin");
      let finalized = 0;
      try {
        const exit = await Effect.runPromise(
          Effect.gen(function* () {
            const started = yield* Deferred.make<void>();
            const body = Stream.concat(
              Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.as(bytes("a")))),
              Stream.never,
            ).pipe(
              Stream.ensuring(
                Effect.sync(() => {
                  finalized += 1;
                }),
              ),
            );
            const fiber = yield* Effect.forkChild(
              Effect.scoped(
                mode === "collect"
                  ? collectVerifiedStream({ body })
                  : persistVerifiedStream({ body, destinationPath: target }),
              ),
            );
            yield* Deferred.await(started);
            yield* Fiber.interrupt(fiber);
            return yield* Fiber.await(fiber);
          }).pipe(Effect.timeout("1 second")),
        );
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        expect(finalized).toBe(1);
        expect(await fs.readdir(dir)).toEqual([]);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    test(`${mode} accepts exact and empty bodies and rejects an undersized EOF`, async () => {
      const dir = await fs.mkdtemp(join(tmpdir(), "lando-size-controls-"));
      const target = join(dir, "artifact.bin");
      const run = (content: string, expectedSizeBytes: number) =>
        Effect.scoped(
          mode === "collect"
            ? collectVerifiedStream({
                body: Stream.make(bytes(content)),
                expectedSizeBytes,
                expectedSha256: digest(content),
              })
            : persistVerifiedStream({
                body: Stream.make(bytes(content)),
                destinationPath: target,
                expectedSizeBytes,
                expectedSha256: digest(content),
              }),
        );
      try {
        expect(await Effect.runPromise(run("abc", 3))).toEqual({ sha256: digest("abc"), sizeBytes: 3 });
        expect(await Effect.runPromise(run("", 0))).toEqual({ sha256: digest(""), sizeBytes: 0 });
        const error = await Effect.runPromise(run("a", 2).pipe(Effect.flip));
        expect(error.reason).toBe("size");
        expect(error.actualSizeBytes).toBe(1);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }
});
