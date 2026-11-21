import { expect, test } from "bun:test";
import { failureOutcomeFromCause, orDieWithRole } from "@lando/sdk/command-result";
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
    const source = Stream.fail(failure).pipe(
      Stream.ensuring(Effect.die(sourceCleanup).pipe(orDieWithRole("cleanup"))),
    );
    const exit = await Effect.runPromiseExit(
      Stream.runDrain(
        compressDumpStream(source, compression).pipe(
          Stream.ensuring(Effect.die(outerCleanup).pipe(orDieWithRole("cleanup"))),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected source failure");
    const outcome = failureOutcomeFromCause(exit.cause);
    expect(outcome.kind).toBe("typed");
    expect(outcome.error).toBe(failure);
    expect(outcome.additionalErrors).toEqual([
      { role: "cleanup", error: sourceCleanup },
      { role: "cleanup", error: outerCleanup },
    ]);
  });
}
