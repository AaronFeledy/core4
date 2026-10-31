import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as BunProcessRunner from "@lando/engine/services/process-runner";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { BunSelfReentryError, FileIoError, ProcessExecError } from "@lando/sdk/errors";
import { ProcessRunner } from "@lando/sdk/services";
import { Effect } from "effect";
import { bunSelfRun } from "../../src/cli/commands/bun-self-runner.ts";
import { processRunnerFor } from "../_support/process-runner.ts";
import { withEnvVar } from "../_support/temp-cwd.ts";

test.skipIf(process.platform === "win32").each([undefined, "caller-pwd", ""])(
  "BunSelfRunner uses native directory identity while preserving explicit PWD %j",
  async (pwd) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-self-context-"));
    let calls = 0;
    try {
      await mkdir(join(root, "physical", "inside"), { recursive: true });
      await symlink("physical/inside", join(root, "link"));
      await writeFile(join(root, "marker"), "wrong");
      await writeFile(join(root, "physical", "marker"), "physical");
      const cwd = await realpath(join(root, "physical"));
      const argv = [
        "-e",
        'process.stdout.write(JSON.stringify([process.cwd(), process.env.PWD, await Bun.file("marker").text(), process.env.NPM_TOKEN, process.env.BUN_BE_BUN, process.env.LANDO_DISALLOW_BUN_BE_BUN_REENTRY])); process.exit(7)',
      ];
      // When
      const result = await Effect.runPromise(
        bunSelfRun({
          argv,
          cwd: `${root}/link/..`,
          env: { NPM_TOKEN: "registry-auth", ...(pwd === undefined ? {} : { PWD: pwd }) },
        }).pipe(
          Effect.provideService(
            ProcessRunner,
            processRunnerFor((options) =>
              Effect.gen(function* () {
                calls++;
                expect([options.cmd, ...options.args]).toEqual([process.execPath, ...argv]);
                expect(options.cwd).toBe(cwd);
                return yield* Effect.flatMap(ProcessRunner, (runner) => runner.run(options)).pipe(
                  Effect.provide(BunProcessRunner.layer),
                );
              }),
            ),
          ),
        ),
      );
      // Then
      expect(calls).toBe(1);
      expect(result.exitCode).toBe(7);
      expect(result.mode).toBe("collected");
      if (result.mode !== "collected") throw new TypeError("Expected collected output");
      expect(JSON.parse(result.stdout)).toEqual([cwd, pwd ?? cwd, "physical", "[redacted]", "1", "1"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("BunSelfRunner rejects invalid cwd before invoking even a fake spawner", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-self-invalid-"));
  let spawned = false;
  try {
    // When
    const result = await Effect.runPromise(
      bunSelfRun({
        argv: ["--version"],
        cwd: join(root, "missing"),
      }).pipe(
        Effect.provideService(
          ProcessRunner,
          processRunnerFor(() =>
            Effect.sync(() => {
              spawned = true;
              return { exitCode: 0 };
            }),
          ),
        ),
        Effect.result,
      ),
    );
    // Then
    expect(spawned).toBe(false);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(FileIoError);
      expect(result.failure).toMatchObject({ _tag: "FileIoError", path: join(root, "missing") });
      expect(typeof result.failure.remediation).toBe("string");
      expect(result.failure.remediation.length).toBeGreaterThan(0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([{ caller: "0" as const }, { caller: "" as const }, { caller: undefined }])(
  "inherited parent reentry marker guards before prep regardless of caller env %j",
  async ({ caller }) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-self-reentry-"));
    const missing = join(root, "missing");
    let spawned = false;
    try {
      // When
      const result = await withEnvVar("LANDO_DISALLOW_BUN_BE_BUN_REENTRY", "1", () =>
        Effect.runPromise(
          bunSelfRun({
            argv: ["--version"],
            cwd: missing,
            execPath: "/bin/bun-reentry",
            verb: "install",
            callerSubsystem: "cli:meta:plugin:add",
            env: caller === undefined ? { OTHER: "1" } : { LANDO_DISALLOW_BUN_BE_BUN_REENTRY: caller },
          }).pipe(
            Effect.provideService(
              ProcessRunner,
              processRunnerFor(() =>
                Effect.sync(() => {
                  spawned = true;
                  return { exitCode: 0 };
                }),
              ),
            ),
            Effect.result,
          ),
        ),
      );
      // Then
      expect(spawned).toBe(false);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(BunSelfReentryError);
        expect(result.failure).toMatchObject({
          _tag: "BunSelfReentryError",
          execPath: "/bin/bun-reentry",
          verb: "install",
          callerSubsystem: "cli:meta:plugin:add",
        });
        expect(result.failure).not.toHaveProperty("exitCode");
        expect(result.failure).not.toHaveProperty("cause");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "BunSelfRunner redacts ProcessExecError spawn failures and disposes the acquired launcher",
  async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-self-error-"));
    let launcherPath = "";
    let spawnCwd = "";
    try {
      await writeFile(join(root, "lando"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      // When
      const result = await Effect.runPromise(
        bunSelfRun({
          argv: ["--version"],
          cwd: root,
          execPath: "/bin/bun-topsecret",
          env: { PATH: root, BUN_AUTH_TOKEN: "topsecret" },
        }).pipe(
          Effect.provideService(
            ProcessRunner,
            processRunnerFor(({ env, cwd }) =>
              Effect.suspend(() => {
                spawnCwd = cwd ?? "";
                launcherPath = Bun.which("lando", { PATH: env?.PATH ?? "" }) ?? "";
                return Effect.fail(
                  new ProcessExecError({
                    cmd: "/bin/bun-topsecret",
                    cwd: spawnCwd,
                    message: "spawn topsecret",
                    cause: { code: "ENOENT" },
                    remediation: "Fix executable permissions.",
                  }),
                );
              }),
            ),
          ),
          Effect.provideService(RedactionService, makeRedactionService()),
          Effect.result,
        ),
      );
      // Then
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(ProcessExecError);
        const failure = result.failure;
        if (!(failure instanceof ProcessExecError)) throw new Error("expected ProcessExecError");
        expect(failure.cmd).toBe("/bin/bun-[redacted]");
        expect(failure.cwd).toBe(spawnCwd);
        expect(failure.cause).toBeDefined();
        expect(JSON.parse(JSON.stringify(failure))).not.toHaveProperty("exitCode");
        expect(JSON.stringify(failure)).not.toContain("topsecret");
        expect(result.failure.remediation.length).toBeGreaterThan(0);
      }
      expect(launcherPath).not.toBe("");
      await expect(access(dirname(launcherPath))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
