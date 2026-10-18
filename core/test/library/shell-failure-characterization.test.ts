import "@lando/core/bundled-plugins";
import { describe, expect, test } from "bun:test";
import { makeLandoRuntime, openLandoRuntime } from "@lando/core";
import { invokeOperation } from "@lando/core/cli/operations";
import { createBufferedRendererIO } from "@lando/core/testing";
import * as RendererRuntime from "@lando/renderer/runtime";
import { Cause, Effect, Exit } from "effect";
import {
  ShellFailure,
  normalizeRejectionJson,
  shellFailureCases,
} from "../_support/shell-failure-characterization";

describe("library shell failure characterization", () => {
  for (const seam of ["layer", "retained"] as const) {
    for (const format of ["text", "json"] as const) {
      for (const scenario of shellFailureCases) {
        test(`${seam} ${format} stays silent and rejects ${scenario.kind}`, async () => {
          // Given: library renderer mode, not a CLI --format flag (the library has no such flag).
          const io = createBufferedRendererIO();
          const exitCodeBefore = process.exitCode;
          const renderer =
            format === "text" ? RendererRuntime.layerPlainService(io) : RendererRuntime.layerJsonService(io);
          const options = {
            renderer: format === "text" ? "plain" : "json",
            plugins: { policy: "bundled-only", layers: [renderer] },
          } as const;
          const program =
            seam === "layer"
              ? scenario.effect().pipe(Effect.provide(makeLandoRuntime({ ...options, bootstrap: "minimal" })))
              : Effect.scoped(
                  Effect.gen(function* () {
                    const runtime = yield* openLandoRuntime(options);
                    return yield* runtime.run(scenario.effect());
                  }),
                );

          // When: observe the actual promise rejection, not Cause.squash or a synthesized envelope.
          const rejection: unknown = await Effect.runPromise(program).then(
            () => {
              throw new Error("Expected the library program to reject");
            },
            (error: unknown) => error,
          );

          // Then: no automatic text, JSON envelope, or process exit mutation.
          expect(rejection).toBeInstanceOf(Error);
          if (!(rejection instanceof Error)) throw new Error("Expected an Error rejection");
          expect(rejection.name).toBe(scenario.rejectionName);
          expect(rejection.message).toBe(scenario.rejectionMessage);
          expect(String(rejection)).toBe(scenario.rejectionText);
          expect(normalizeRejectionJson(rejection)).toEqual(scenario.rejectionJson);
          const exit = await Effect.runPromiseExit(program);
          if (!Exit.isFailure(exit)) throw new Error("Expected a failed Exit");
          expect(normalizeRejectionJson(exit.cause)).toEqual(scenario.rejectionCause);
          expect({ stdout: io.stdout(), stderr: io.stderr() }).toEqual({ stdout: "", stderr: "" });
          expect(process.exitCode).toBe(exitCodeBefore);
        });
      }
    }
  }

  test("embedding operation returns a tagged-failure envelope with host-rendered output", async () => {
    // Given
    const operation = shellFailureCases[0].effect();
    // When
    const result = await Effect.runPromise(
      invokeOperation(operation, {
        renderError: (error) => `${error.message}\n${error.remediation}`,
      }).pipe(Effect.provide(makeLandoRuntime({ bootstrap: "minimal" }))),
    );
    // Then
    expect(result).toMatchObject({
      ok: false,
      error: shellFailureCases[0].error,
      output: "operation refused\nRetry with valid input.",
    });
  });

  test("embedding operation returns primary and additional typed failures", async () => {
    const operation = Effect.failCause(
      Cause.combine(
        Cause.fail(new ShellFailure({ message: "first failure", remediation: "Retry first." })),
        Cause.fail(new ShellFailure({ message: "second failure", remediation: "Retry second." })),
      ),
    );
    const renderedErrors: string[] = [];
    const result = await Effect.runPromise(
      invokeOperation(operation, {
        renderError: (error) => {
          renderedErrors.push(error.message);
          return error.message;
        },
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "ShellFailure", message: "first failure", remediation: "Retry first." },
      additionalErrors: [{ _tag: "ShellFailure", message: "second failure", remediation: "Retry second." }],
      output: "first failure",
    });
    expect(renderedErrors).toEqual(["first failure"]);
  });

  for (const scenario of shellFailureCases.filter(
    (entry) => entry.kind !== "tagged" && entry.kind !== "combined",
  )) {
    test(`embedding operation propagates ${scenario.kind} instead of returning a failure envelope`, async () => {
      // Given
      const renderedErrors: string[] = [];
      // When
      const rejection: unknown = await Effect.runPromise(
        invokeOperation(scenario.effect(), {
          renderError: () => {
            renderedErrors.push("unexpected render");
            return "unexpected render";
          },
        }).pipe(Effect.provide(makeLandoRuntime({ bootstrap: "minimal" }))),
      ).then(
        () => {
          throw new Error("Expected rejection instead of an envelope");
        },
        (error: unknown) => error,
      );
      // Then
      expect(rejection).toBeInstanceOf(Error);
      if (!(rejection instanceof Error)) throw new Error("Expected an Error rejection");
      expect(rejection.name).toBe("Error");
      expect(rejection.message.replaceAll(/fiber \(#\d+\)/g, "fiber (#<id>)")).toBe(scenario.causeText);
      expect(Cause.isCause(rejection.cause)).toBe(true);
      expect(normalizeRejectionJson(rejection.cause)).toEqual(scenario.rejectionCause);
      expect(renderedErrors).toEqual([]);
    });
  }
});
