import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { ShellExecError } from "@lando/core/errors";
import { ShellRunner } from "@lando/core/services";
import type { ShellCommandOptions } from "@lando/sdk/services";
import { ShellRunnerLive } from "../../src/services/shell-runner.ts";

const execShell = (command: string, options?: ShellCommandOptions) =>
  Effect.runPromise(
    Effect.flatMap(ShellRunner, (shellRunner) => shellRunner.exec(command, options)).pipe(
      Effect.provide(ShellRunnerLive),
    ),
  );

describe("ShellRunnerLive", () => {
  test("runs a command with env and captures stdout", async () => {
    const result = await execShell("echo $FOO", { env: { FOO: "bar" } });

    expect(result).toEqual({ exitCode: 0, stdout: "bar\n", stderr: "" });
  });

  test("runs shell metacharacters through Bun shell", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lando-shell-runner-"));
    try {
      const result = await execShell("printf 'hi' | tr a-z A-Z && printf '!' > output.txt", { cwd });

      expect(result).toEqual({ exitCode: 0, stdout: "HI", stderr: "" });
      expect(await Bun.file(join(cwd, "output.txt")).text()).toBe("!");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("fails with ShellExecError for invalid shell syntax", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(ShellRunner, (shellRunner) => shellRunner.exec("echo &&")).pipe(
        Effect.provide(ShellRunnerLive),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ShellExecError);
        expect(failure.value.command).toBe("echo &&");
      }
    }
  });

  test("fails with ShellExecError for non-zero exits", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(ShellRunner, (shellRunner) => shellRunner.exec("printf 'nope' && exit 7")).pipe(
        Effect.provide(ShellRunnerLive),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ShellExecError);
        expect(failure.value.exitCode).toBe(7);
        expect(failure.value.stdout).toBe("nope");
      }
    }
  });
});
