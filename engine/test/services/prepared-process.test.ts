import { expect, spyOn, test } from "bun:test";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProcessRunner, type ProcessSpawnOptions } from "@lando/sdk/services";
import { Cause, Effect, Exit, Stream } from "effect";
import * as BunCommandEnv from "../../src/services/bun-command-env.ts";
import * as HostContext from "../../src/services/host-execution-context.ts";
import * as BunProcessRunner from "../../src/services/process-runner.ts";

test("prepares the exact request once while nested requests retain ordinary preparation", async () => {
  const prepare = spyOn(HostContext, "prepareHostExecutionContext");
  try {
    const result = await Effect.runPromise(
      BunProcessRunner.withPreparedProcess(
        {
          cmd: process.execPath,
          args: ["-e", "process.stdout.write(process.env.PWD)"],
          env: { BUN_BE_BUN: "1", PWD: "" },
        },
        (runner, request) =>
          Effect.gen(function* () {
            const first = yield* runner.run(request);
            const nested = yield* runner.run({ ...request, env: { ...request.env, PWD: "nested" } });
            return { first, nested };
          }),
      ).pipe(Effect.provide(BunProcessRunner.layer)),
    );
    expect(result.first.stdout).toBe("");
    expect(result.nested.stdout).toBe("nested");
    expect(prepare).toHaveBeenCalledTimes(2);
  } finally {
    prepare.mockRestore();
  }
});

test("an asynchronous preparation barrier preserves request and host snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-prepared-snapshot-"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = HostContext.prepareHostExecutionContext;
  const prepare = spyOn(HostContext, "prepareHostExecutionContext").mockImplementation(async (...args) => {
    entered.resolve();
    await release.promise;
    return original(...args);
  });
  const previous = process.env.LANDO_PREPARED_TEST;
  const previousTemp = process.env.TMPDIR;
  const beforeCwd = process.cwd();
  const beforeExec = process.execPath;
  const beforeTemp = tmpdir();
  const createLauncher = BunCommandEnv.createBunCommandEnv;
  const launcher = spyOn(BunCommandEnv, "createBunCommandEnv").mockImplementation((options, runtime) => {
    expect(runtime?.execPath).toBe(beforeExec);
    expect(options.tempRoot).toBe(beforeTemp);
    return createLauncher(options, runtime);
  });
  let observed: ProcessSpawnOptions | undefined;
  const args = ["before"];
  const env = { CALLER: "before", PWD: "", PATH: root };
  const runner = ProcessRunner.of({
    run: (input) =>
      Effect.sync(() => {
        observed = input;
        return { exitCode: 17, stdout: "", stderr: "" };
      }),
    stream: () => Stream.empty,
    streamWithExit: () => Stream.empty,
  });
  try {
    await writeFile(join(root, "lando"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    process.env.LANDO_PREPARED_TEST = "before";
    const running = Effect.runPromise(
      BunProcessRunner.withPreparedProcess({ cmd: process.execPath, args, env }, (service, request) =>
        service.run(request),
      ).pipe(Effect.provideService(ProcessRunner, runner)),
    );
    await entered.promise;
    args[0] = "after";
    env.CALLER = "after";
    process.env.LANDO_PREPARED_TEST = "after";
    process.env.TMPDIR = join(root, "missing-temp");
    process.chdir(root);
    process.execPath = "/late-runtime";
    release.resolve();
    expect((await running).exitCode).toBe(17);
    expect(observed?.args).toEqual(["before"]);
    expect(observed?.cmd).toBe(beforeExec);
    expect(observed?.cwd).toBe(await realpath(beforeCwd));
    expect(observed?.env).toMatchObject({ CALLER: "before", PWD: "", LANDO_PREPARED_TEST: "before" });
    expect(prepare).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    prepare.mockRestore();
    launcher.mockRestore();
    process.chdir(beforeCwd);
    process.execPath = beforeExec;
    if (previousTemp === undefined) Reflect.deleteProperty(process.env, "TMPDIR");
    else process.env.TMPDIR = previousTemp;
    if (previous === undefined) Reflect.deleteProperty(process.env, "LANDO_PREPARED_TEST");
    else process.env.LANDO_PREPARED_TEST = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "cancellation joins a SIGTERM-resistant stream before disposing its launcher",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-prepared-cancel-"));
    const controller = new AbortController();
    let launcher = "";
    let pid = 0;
    try {
      await writeFile(join(root, "lando"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const program = BunProcessRunner.withPreparedProcess(
        {
          cmd: process.execPath,
          env: { PATH: root, BUN_BE_BUN: "1" },
          args: [
            "-e",
            'process.on("SIGTERM",()=>{}); console.log(JSON.stringify({pid:process.pid,path:Bun.which("lando")})); setInterval(()=>{},1000)',
          ],
        },
        (runner, request) =>
          Stream.runForEach(runner.streamWithExit(request), (event) =>
            Effect.gen(function* () {
              if (!("kind" in event)) return;
              const line = new TextDecoder().decode(event.chunk);
              const parsed: unknown = JSON.parse(line);
              if (
                typeof parsed !== "object" ||
                parsed === null ||
                !("pid" in parsed) ||
                !("path" in parsed) ||
                typeof parsed.pid !== "number" ||
                typeof parsed.path !== "string"
              )
                throw new TypeError("Invalid child readiness record");
              launcher = parsed.path;
              pid = parsed.pid;
              yield* Effect.promise(() => access(launcher));
              controller.abort();
            }),
          ),
      );
      const result = await Effect.runPromiseExit(program.pipe(Effect.provide(BunProcessRunner.layer)), {
        signal: controller.signal,
      });
      expect(result._tag).toBe("Failure");
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(access(dirname(launcher))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      controller.abort();
      await rm(root, { recursive: true, force: true });
    }
  },
  10000,
);

test("cancellation during directory preparation never acquires a launcher or invokes the runner", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const controller = new AbortController();
  const original = HostContext.prepareHostExecutionContext;
  const prepare = spyOn(HostContext, "prepareHostExecutionContext").mockImplementation(async (...args) => {
    entered.resolve();
    try {
      await release.promise;
      return await original(...args);
    } finally {
      finished.resolve();
    }
  });
  const launcher = spyOn(BunCommandEnv, "createBunCommandEnv");
  let invoked = false;
  try {
    const running = Effect.runPromiseExit(
      BunProcessRunner.withPreparedProcess({ cmd: process.execPath, args: [] }, () =>
        Effect.sync(() => {
          invoked = true;
        }),
      ).pipe(Effect.provide(BunProcessRunner.layer)),
      { signal: controller.signal },
    );
    await entered.promise;
    controller.abort();
    const exit = await running;
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(invoked).toBe(false);
    expect(launcher).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await finished.promise;
    prepare.mockRestore();
    launcher.mockRestore();
  }
});
