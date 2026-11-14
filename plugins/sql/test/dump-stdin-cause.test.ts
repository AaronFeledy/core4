import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandStdioError } from "@lando/sdk/errors";
import { Cause, Context, Effect, Exit, Stream } from "effect";
import { prepareImportDump } from "../src/dump-file.ts";

class SourceAnnotation extends Context.Service<SourceAnnotation, string>()("sql/test/StdinAnnotation") {}

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-stdin-cause-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const prepare = (stdin: Stream.Stream<Uint8Array, CommandStdioError>, stagingDir = join(root, "stage")) =>
  prepareImportDump({
    file: "-",
    appRoot: root,
    stagingDir,
    stdin,
    completeness: undefined,
    privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
  });

const stdioFailure = () =>
  new CommandStdioError({
    message: "stdin closed early",
    command: "db:import",
    stream: "stdin",
    reason: "read",
    remediation: "Supply the complete dump.",
  });

for (const compression of ["none", "gzip", "zstd"] as const) {
  const payload = new TextEncoder().encode("select 1;\n".repeat(100));
  const bytes =
    compression === "none"
      ? payload
      : compression === "gzip"
        ? Bun.gzipSync(payload)
        : Bun.zstdCompressSync(payload);
  for (const position of ["early", "prefix", "body"] as const) {
    test.each(["typed", "defect", "interrupt", "mixed"] as const)(
      `${compression} ${position} stdin preserves annotated %s reasons by identity`,
      async (kind) => {
        const failure = stdioFailure();
        const defect = new Error("producer defect");
        const cause: Cause.Cause<CommandStdioError> = Cause.annotate(
          kind === "typed"
            ? Cause.fail(failure)
            : kind === "defect"
              ? Cause.die(defect)
              : kind === "interrupt"
                ? Cause.interrupt(2046)
                : Cause.combine(Cause.fail(failure), Cause.combine(Cause.die(defect), Cause.interrupt(2046))),
          Context.make(SourceAnnotation, "stdin provenance"),
        );
        const source =
          position === "early"
            ? Stream.failCause(cause)
            : Stream.concat(
                Stream.make(bytes.subarray(0, position === "prefix" ? 1 : bytes.length)),
                Stream.failCause(cause),
              );

        const exit = await Effect.runPromiseExit(Effect.scoped(prepare(source)));

        if (!Exit.isFailure(exit)) throw new Error("expected stdin failure");
        expect(exit.cause.reasons.map((reason) => reason._tag)).toEqual(
          cause.reasons.map((reason) => reason._tag),
        );
        for (const [index, reason] of cause.reasons.entries()) {
          const actual = exit.cause.reasons[index];
          if (actual === undefined) throw new Error("missing source reason");
          expect(Context.getOrUndefined(Cause.reasonAnnotations(actual), SourceAnnotation)).toBe(
            "stdin provenance",
          );
          if (Cause.isFailReason(reason))
            expect(Cause.isFailReason(actual) && actual.error).toBe(reason.error);
          if (Cause.isDieReason(reason))
            expect(Cause.isDieReason(actual) && actual.defect).toBe(reason.defect);
          if (Cause.isInterruptReason(reason))
            expect(Cause.isInterruptReason(actual) && actual.fiberId).toBe(reason.fiberId);
        }
      },
    );
  }

  test(`${compression} stdin preserves source cleanup and appends outer cleanup`, async () => {
    const failure = stdioFailure();
    const sourceCleanup = new Error("source cleanup");
    const outerCleanup = new Error("outer cleanup");
    const source = Stream.concat(Stream.make(bytes), Stream.fail(failure)).pipe(
      Stream.ensuring(Effect.die(sourceCleanup)),
    );

    const exit = await Effect.runPromiseExit(
      Effect.scoped(prepare(source).pipe(Effect.ensuring(Effect.die(outerCleanup)))),
    );

    if (!Exit.isFailure(exit)) throw new Error("expected stdin failure");
    expect(exit.cause.reasons).toHaveLength(3);
    const [primary, sourceFinalizer, outerFinalizer] = exit.cause.reasons;
    if (primary === undefined || sourceFinalizer === undefined || outerFinalizer === undefined) {
      throw new Error("missing failure or cleanup reason");
    }
    expect(Cause.isFailReason(primary) && primary.error).toBe(failure);
    expect(Cause.isDieReason(sourceFinalizer) && sourceFinalizer.defect).toBe(sourceCleanup);
    expect(Cause.isDieReason(outerFinalizer) && outerFinalizer.defect).toBe(outerCleanup);
    expect(await readdir(join(root, "stage"))).toEqual([]);
  });

  test(`${compression} prefetched producer failure does not replace independent staging failure`, async () => {
    const stagingDir = join(root, "blocked");
    await writeFile(stagingDir, "keep");
    let producerFailed = false;
    const source = Stream.concat(
      Stream.make(bytes),
      Stream.unwrap(
        Effect.sync(() => {
          producerFailed = true;
          return Stream.die(new Error("prefetched producer defect"));
        }),
      ),
    );

    const exit = await Effect.runPromiseExit(Effect.scoped(prepare(source, stagingDir)));

    if (!Exit.isFailure(exit)) throw new Error("expected staging failure");
    expect(producerFailed).toBe(true);
    expect(exit.cause.reasons).toMatchObject([
      {
        _tag: "Fail",
        error: {
          _tag: "DataTransferError",
          operation: "stage",
          cause: { _tag: "FileIoError", path: stagingDir },
        },
      },
    ]);
  });
}
