import { expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { annotateFailureRole } from "@lando/sdk/command-result";
import { Cause, Effect, Layer, Schema } from "effect";
import { formatBugReport } from "../../src/cli/bug-report";
import { commandFailureOutcome, commandInterruptionExitCode } from "../../src/cli/command-interruption";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";
import { renderTerminalFailure } from "../../src/cli/terminal-failure";

for (const reason of ["SIGINT", "SIGTERM", { secret: "private-abort-reason" }] as const)
  for (const format of ["json", "text"] as const)
    test(`pure interruption renders ordinary ${format} cancellation (${String(reason)})`, async () => {
      const controller = new AbortController();
      const io = createBufferedRendererIO();
      const codes: number[] = [];
      await runWithRendererHandling(
        Effect.sync(() => controller.abort(reason)).pipe(Effect.andThen(Effect.never)),
        {
          runtime: Layer.empty,
          command: "app:exec",
          signal: controller.signal,
          resultSchema: Schema.Unknown,
          rendererMode: "plain",
          resultFormat: format,
          io,
          setExitCode: (code) => codes.push(code),
          formatError: (failure, redactor) =>
            formatBugReport({
              ...failure,
              redactor,
              context: { commandId: "app:exec" },
              rendererMode: "plain",
            }),
        },
      );
      expect(codes).toEqual([reason === "SIGINT" ? 130 : reason === "SIGTERM" ? 143 : 1]);
      const output = io.stdout() + io.stderr();
      expect(output).toContain("Command interrupted.");
      expect(output).not.toMatch(
        /LandoInternalError|All fibers interrupted|--debug|private-abort-reason|reporting this failure/,
      );
      if (format === "json") {
        expect(JSON.parse(io.stdout())).toMatchObject({
          ok: false,
          error: { _tag: "CommandInterruptedError" },
        });
        expect(JSON.parse(io.stdout()).result).toBeUndefined();
        expect(JSON.parse(io.stdout()).error.signal).toBe(typeof reason === "string" ? reason : undefined);
      }
    });

test("mixed typed failure, interruption and cleanup defect retain primary and roles with an aborted signal", async () => {
  const controller = new AbortController();
  const primary = { _tag: "InputError", message: "refused", remediation: "Repair input." };
  const cause = Cause.combine(
    Cause.combine(Cause.fail(primary), Cause.interrupt()),
    annotateFailureRole(Cause.die(new Error("cleanup broke")), "cleanup"),
  );
  controller.abort("SIGTERM");
  const projected = commandFailureOutcome(cause, controller.signal);
  expect(projected.error).toBe(primary);
  expect(projected.additionalErrors).toMatchObject([
    { role: "cleanup", error: { _tag: "LandoInternalError", message: "cleanup broke" } },
  ]);
  const io = createBufferedRendererIO();
  const codes: number[] = [];
  await renderTerminalFailure(
    cause,
    {
      runtime: Layer.empty,
      rendererMode: "plain",
      resultFormat: "json",
      io,
      signal: controller.signal,
      setExitCode: (code) => codes.push(code),
      formatError: () => "unused",
    },
    createStandaloneRedactor("secrets"),
  );
  expect(codes).toEqual([1]);
  expect(JSON.parse(io.stdout()).error).toMatchObject({
    _tag: "InputError",
    additionalErrors: [{ _tag: "LandoInternalError", role: "cleanup" }],
  });
});

test("terminal fallback shares typed interruption and safe signal projection", async () => {
  const controller = new AbortController();
  controller.abort("SIGTERM");
  const io = createBufferedRendererIO();
  const codes: number[] = [];
  await renderTerminalFailure(
    Cause.interrupt(),
    {
      runtime: Layer.empty,
      rendererMode: "plain",
      resultFormat: "json",
      io,
      signal: controller.signal,
      setExitCode: (code) => codes.push(code),
      formatError: () => "unused",
    },
    createStandaloneRedactor("secrets"),
  );
  expect(codes).toEqual([143]);
  expect(JSON.parse(io.stdout())).toMatchObject({
    ok: false,
    error: { _tag: "CommandInterruptedError", signal: "SIGTERM" },
  });
});

test("unaborted signals do not provide a conventional interruption code", () => {
  expect(commandInterruptionExitCode(new AbortController().signal)).toBe(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const)
  test(`suppressed ${signal} interruption finalizes without output or an exit-code write`, async () => {
    const controller = new AbortController();
    const io = createBufferedRendererIO();
    const codes: number[] = [];
    let finalized = false;
    const operation = Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          finalized = true;
        }),
      );
      controller.abort(signal);
      yield* Effect.never;
    }).pipe(Effect.scoped);
    await runWithRendererHandling(operation, {
      runtime: Layer.empty,
      rendererMode: "plain",
      resultFormat: "json",
      signal: controller.signal,
      suppressInterruptionDiagnostics: true,
      io,
      setExitCode: (code) => codes.push(code),
      formatError: () => "unused",
    });
    expect(finalized).toBe(true);
    expect({ stdout: io.stdout(), stderr: io.stderr(), codes }).toEqual({
      stdout: "",
      stderr: "",
      codes: [],
    });
  });

for (const order of ["boundary-first", "provider-first"] as const)
  test(`same-tick ${order} cancellation preserves a genuine failure and cleanup role`, async () => {
    const controller = new AbortController();
    const primary = { _tag: "InputError", message: "refused", remediation: "Repair input." };
    const cleanup = annotateFailureRole(Cause.die(new Error("cleanup broke")), "cleanup");
    const io = createBufferedRendererIO();
    const codes: number[] = [];
    const operation = Effect.uninterruptible(
      Effect.gen(function* () {
        if (order === "boundary-first") controller.abort("SIGINT");
        return yield* Effect.fail(primary);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (order === "provider-first") controller.abort("SIGINT");
          }).pipe(Effect.andThen(Effect.failCause(cleanup))),
        ),
      ),
    );
    await runWithRendererHandling(operation, {
      runtime: Layer.empty,
      rendererMode: "plain",
      resultFormat: "json",
      signal: controller.signal,
      io,
      failureExitCode: () => 23,
      setExitCode: (code) => codes.push(code),
      formatError: () => "unused",
    });
    expect(codes).toEqual([23]);
    expect(JSON.parse(io.stdout()).error).toMatchObject({
      _tag: "InputError",
      additionalErrors: [{ _tag: "LandoInternalError", role: "cleanup" }],
    });
  });
