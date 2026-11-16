import { expect, test } from "bun:test";
import { DataTransferError } from "@lando/sdk/errors";
import { Cause, Context, Effect, Exit, Stream } from "effect";
import { compressDumpStream } from "../src/compression.ts";

class SourceAnnotation extends Context.Service<SourceAnnotation, string>()("sql/test/SourceAnnotation") {}

for (const compression of ["gzip", "zstd"] as const) {
  test.each(["typed-and-defect", "defect-only", "interrupt-only", "typed-defect-and-interrupt"] as const)(
    `${compression} preserves the complete annotated %s source cause`,
    async (kind) => {
      const failure = new DataTransferError({
        message: "Provider failed",
        operation: "exec",
        remediation: "Restart the provider.",
      });
      const defect = new Error("source finalizer failed");
      const sourceCause = Cause.annotate(
        kind === "interrupt-only"
          ? Cause.interrupt(2046)
          : kind === "defect-only"
            ? Cause.die(defect)
            : Cause.combine(
                Cause.fail(failure),
                kind === "typed-defect-and-interrupt"
                  ? Cause.combine(Cause.die(defect), Cause.interrupt(2046))
                  : Cause.die(defect),
              ),
        Context.make(SourceAnnotation, "source annotation"),
      );
      const exit = await Effect.runPromiseExit(
        Stream.runDrain(compressDumpStream(Stream.failCause(sourceCause), compression)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) throw new Error("expected source failure");
      expect(exit.cause.reasons).toEqual(sourceCause.reasons);
      expect(
        exit.cause.reasons.map((reason) =>
          Context.getOrUndefined(Cause.reasonAnnotations(reason), SourceAnnotation),
        ),
      ).toEqual(sourceCause.reasons.map(() => "source annotation"));
    },
  );

  test(`${compression} retains cleanup defects added after the codec bridge`, async () => {
    const failure = new DataTransferError({
      message: "Provider failed",
      operation: "exec",
      remediation: "Restart the provider.",
    });
    const sourceCleanup = new Error("source cleanup");
    const outerCleanup = new Error("outer cleanup");
    const source = Stream.fail(failure).pipe(Stream.ensuring(Effect.die(sourceCleanup)));
    const exit = await Effect.runPromiseExit(
      Stream.runDrain(
        compressDumpStream(source, compression).pipe(Stream.ensuring(Effect.die(outerCleanup))),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected source failure");
    expect(exit.cause.reasons).toMatchObject([
      { _tag: "Fail", error: failure },
      { _tag: "Die", defect: sourceCleanup },
      { _tag: "Die", defect: outerCleanup },
    ]);
  });
}
