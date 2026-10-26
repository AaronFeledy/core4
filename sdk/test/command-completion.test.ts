import { describe, expect, test } from "bun:test";
import {
  buildCommandResultEnvelope,
  commandCompletionFromExitCode,
  identityRedactor,
  resolveCommandCompletion,
} from "@lando/sdk/command-result";
import { Effect, Schema } from "effect";

describe("command completion", () => {
  test("encodes and projects retained failure values through the declared result schema", async () => {
    const outcome = resolveCommandCompletion("process", { selected: 7, omitted: 8 }, () => ({
      ok: false,
      exitCode: 7,
    }));
    const envelope = await Effect.runPromise(
      buildCommandResultEnvelope({
        command: "process",
        resultSchema: Schema.Struct({ selected: Schema.NumberFromString, omitted: Schema.Number }),
        projectResultKeys: ["selected"],
        outcome,
        redactor: identityRedactor,
      }),
    );
    expect(envelope).toMatchObject({ ok: false, result: { selected: "7" } });
    expect(envelope.result).toEqual({ selected: "7" });
  });
  test("ignores unrelated exitCode fields without an installed policy", () => {
    expect(resolveCommandCompletion("report", { exitCode: 7 })).toEqual({
      _tag: "success",
      value: { exitCode: 7 },
      exitCode: 0,
    });
  });
  test("classifies explicit process statuses without a POSIX ceiling", () => {
    expect(commandCompletionFromExitCode(0)).toEqual({ ok: true, exitCode: 0 });
    expect(commandCompletionFromExitCode(700)).toEqual({ ok: false, exitCode: 700 });
  });
  test("calls the policy once and permits successful reports with findings", () => {
    let calls = 0;
    const result = resolveCommandCompletion("report", false, () => {
      calls++;
      return { ok: true, exitCode: 1 };
    });
    expect(result).toEqual({ _tag: "success", value: false, exitCode: 1 });
    expect(calls).toBe(1);
  });
  test.each([false, 0, { exitCode: 7 }])("retains completed failure value %j", async (value) => {
    const outcome = resolveCommandCompletion("process", value, () => ({ ok: false, exitCode: 7 }));
    const envelope = await Effect.runPromise(
      buildCommandResultEnvelope({
        command: "process",
        resultSchema: Schema.Unknown,
        outcome,
        redactor: identityRedactor,
      }),
    );
    expect(envelope.ok).toBe(false);
    expect(envelope.result).toEqual(value);
    expect(envelope.error?._tag).toBe("LandoCommandError");
  });
  test("rejects installed policies that return no decision", () => {
    expect(() => resolveCommandCompletion("broken", 0, () => JSON.parse("null"))).toThrow();
  });
});
