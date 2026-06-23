import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Queue, Stream } from "effect";

import { ShellExecError } from "@lando/core/errors";
import { EventService, ShellRunner } from "@lando/core/services";
import { createRedactor } from "@lando/sdk/secrets";
import type { LandoEvent, ShellCommandOptions } from "@lando/sdk/services";
import { RedactionService } from "../../src/redaction/service.ts";
import { ShellRunnerLive } from "../../src/services/shell-runner.ts";

const redactionLayer = Layer.succeed(RedactionService, {
  forProfile: () => Effect.succeed(createRedactor("secrets", { values: ["topsecret"] })),
});

const captureEventsLayer = (events: LandoEvent[]) =>
  Layer.succeed(EventService, {
    publish: (event) => Effect.sync(() => events.push(event)),
    subscribe: () => Stream.empty,
    subscribeQueue: Queue.unbounded<never>(),
    waitFor: () => Effect.never,
  } satisfies EventService.Service);

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

  test("redacts constructed ShellExecError fields when RedactionService is present", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lando-shell-topsecret-"));
    try {
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(ShellRunner, (shellRunner) =>
          shellRunner.exec("echo topsecret && echo topsecret 1>&2 && exit 7", {
            cwd,
            env: { BUN_AUTH_TOKEN: "topsecret" },
          }),
        ).pipe(Effect.provide(Layer.mergeAll(ShellRunnerLive, redactionLayer))),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ShellExecError);
          expect(failure.value.message).not.toContain("topsecret");
          expect(failure.value.command).not.toContain("topsecret");
          expect(failure.value.cwd).not.toContain("topsecret");
          expect(failure.value.stdout).not.toContain("topsecret");
          expect(failure.value.stdout).toContain("[redacted]");
          expect(failure.value.stderr ?? "").not.toContain("topsecret");
          expect(failure.value.command).toContain("[redacted]");
          expect(failure.value.cwd).toContain("[redacted]");
        }
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("redacts successful pre/post shell event payloads when RedactionService is present", async () => {
    const events: LandoEvent[] = [];
    const result = await Effect.runPromise(
      Effect.flatMap(ShellRunner, (shellRunner) =>
        shellRunner.exec("echo topsecret", { env: { BUN_AUTH_TOKEN: "topsecret" } }),
      ).pipe(Effect.provide(Layer.mergeAll(ShellRunnerLive, redactionLayer, captureEventsLayer(events)))),
    );

    expect(result.stdout).toContain("topsecret");
    expect(events.map((event) => event._tag)).toEqual(["pre-shell-exec", "post-shell-exec"]);
    const payload = JSON.stringify(events);
    expect(payload).not.toContain("topsecret");
    expect(payload).toContain("[redacted]");
  });

  test("does not publish shell exec events without RedactionService", async () => {
    const events: LandoEvent[] = [];
    const result = await Effect.runPromise(
      Effect.flatMap(ShellRunner, (shellRunner) =>
        shellRunner.exec("echo topsecret", { env: { BUN_AUTH_TOKEN: "topsecret" } }),
      ).pipe(Effect.provide(Layer.mergeAll(ShellRunnerLive, captureEventsLayer(events)))),
    );

    expect(result.stdout).toContain("topsecret");
    expect(events).toEqual([]);
  });
});
