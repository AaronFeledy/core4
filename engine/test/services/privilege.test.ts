import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PrivilegeAuthorizationFailedError,
  PrivilegeCredentialsRequiredError,
  ProcessExecError,
} from "@lando/sdk/errors";
import {
  InteractionService,
  type InteractionServiceShape,
  type ProcessResult,
  ProcessRunner,
  type ProcessSpawnOptions,
} from "@lando/sdk/services";
import { Cause, type Context, Deferred, Effect, Exit, Fiber } from "effect";
import { type ElevationHost, elevationTransport, makePrivilegeService } from "../../src/services/privilege";
import * as BunProcessRunner from "../../src/services/process-runner";

const SUDO = "/usr/bin/sudo";

const host = (overrides: Partial<ElevationHost> = {}): ElevationHost => ({
  platform: "linux",
  euid: () => 1000,
  env: {},
  which: (command) => (command === "sudo" ? SUDO : null),
  isExecutableFile: () => false,
  hasTerminal: () => true,
  ...overrides,
});

const interaction = (interactive: boolean): InteractionServiceShape => ({
  id: "test",
  isInteractive: Effect.succeed(interactive),
  prompt: () => Effect.die("unused"),
  promptAll: () => Effect.die("unused"),
  confirm: () => Effect.die("unused"),
  select: () => Effect.die("unused"),
  secret: () => Effect.die("unused"),
});

const recordingRunner = (answer: (spawn: ProcessSpawnOptions) => number) => {
  const spawns: ProcessSpawnOptions[] = [];
  const runner: Context.Service.Shape<typeof ProcessRunner> = ProcessRunner.of({
    run: (spawn) =>
      Effect.sync((): ProcessResult => {
        spawns.push(spawn);
        return { exitCode: answer(spawn), stdout: "", stderr: "" };
      }),
    stream: () => Effect.die("unused") as never,
    streamWithExit: () => Effect.die("unused") as never,
  });
  return { runner, spawns };
};

const argvOf = (spawn: ProcessSpawnOptions) => [spawn.cmd, ...spawn.args];
const credentialCheck = (spawn: ProcessSpawnOptions) => spawn.args.join(" ") === "-n -v";

const failureOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.findErrorOption(exit.cause);
  return failure._tag === "Some" ? failure.value : undefined;
};

describe("elevationTransport", () => {
  test.each([
    ["win32 has no adapter", host({ platform: "win32" }), "unavailable"],
    ["root runs argv directly", host({ euid: () => 0 }), "direct"],
    ["a host without sudo cannot elevate", host({ which: () => null }), "unavailable"],
    [
      "an executable SUDO_ASKPASS selects askpass",
      host({ env: { SUDO_ASKPASS: "/opt/askpass" }, isExecutableFile: () => true }),
      "askpass",
    ],
    ["a missing SUDO_ASKPASS program is ignored", host({ env: { SUDO_ASKPASS: "/missing" } }), "sudo"],
    ["macOS uses the POSIX sudo path", host({ platform: "darwin" }), "sudo"],
    ["never looks for a helper under the user's home", host({ env: { HOME: "/home/dev" } }), "sudo"],
  ] as const)("%s", (_name, candidate, expected) => {
    expect(elevationTransport(candidate)._tag).toBe(expected);
  });
});

describe("PrivilegeService sudo adapter", () => {
  test("a non-interactive run without credentials fails before running the command", async () => {
    // Given sudo needs a password and the run cannot prompt.
    const { runner, spawns } = recordingRunner((spawn) => (credentialCheck(spawn) ? 1 : 0));
    const service = makePrivilegeService(runner, { host: host() });

    // When
    const exit = await Effect.runPromiseExit(
      service
        .elevate(["/usr/bin/apt-get", "update"])
        .pipe(Effect.provideService(InteractionService, interaction(false))),
    );

    // Then only the non-mutating check ran, and the failure names both ways out.
    const failure = failureOf(exit);
    expect(failure).toBeInstanceOf(PrivilegeCredentialsRequiredError);
    expect(failure?.remediation).toContain("sudo -v");
    expect(failure?.remediation).toContain("SUDO_ASKPASS");
    expect(spawns.map(argvOf)).toEqual([[SUDO, "-n", "-v"]]);
  });

  test("cached credentials run the command once with sudo -n, in Lando's session", async () => {
    const { runner, spawns } = recordingRunner(() => 0);
    const service = makePrivilegeService(runner, { host: host({ hasTerminal: () => false }) });

    await Effect.runPromise(
      service
        .elevate(["/usr/sbin/usermod", "-a"])
        .pipe(Effect.provideService(InteractionService, interaction(true))),
    );

    expect(spawns.map(argvOf)).toEqual([
      [SUDO, "-n", "-v"],
      [SUDO, "-n", "--", "/usr/sbin/usermod", "-a"],
    ]);
    // A private capture is spawned detached in a new session, where sudo's tty ticket is invisible.
    expect(spawns.every((spawn) => spawn.capture !== true)).toBe(true);
  });

  test("an interactive run hands over the terminal before sudo prompts, then runs plain sudo", async () => {
    // Given no cached ticket, an interactive invocation, and real terminals.
    const order: string[] = [];
    const { runner, spawns } = recordingRunner((spawn) => {
      order.push(argvOf(spawn).join(" "));
      return credentialCheck(spawn) ? 1 : 0;
    });
    const service = makePrivilegeService(runner, {
      host: host(),
      prepareTerminal: Effect.sync(() => void order.push("prepare-terminal")),
    });

    // When
    await Effect.runPromise(
      service
        .ensureCredentials("install uidmap")
        .pipe(
          Effect.andThen(service.elevate(["/usr/bin/apt-get", "update"])),
          Effect.provideService(InteractionService, interaction(true)),
        ),
    );

    // Then sudo prompts itself on the terminal Lando released, and the command can prompt again.
    expect(order).toEqual([
      `${SUDO} -n -v`,
      "prepare-terminal",
      `${SUDO} -v`,
      "prepare-terminal",
      `${SUDO} -- /usr/bin/apt-get update`,
    ]);
    const prompt = spawns.find((spawn) => spawn.args.join(" ") === "-v");
    expect(prompt?.inheritStdin).toBe(true);
    expect(prompt?.inheritOutput).toBe(true);
  });

  test("an interactive invocation without real terminals never prompts", async () => {
    const { runner, spawns } = recordingRunner((spawn) => (credentialCheck(spawn) ? 1 : 0));
    const service = makePrivilegeService(runner, { host: host({ hasTerminal: () => false }) });

    const exit = await Effect.runPromiseExit(
      service
        .ensureCredentials("install uidmap")
        .pipe(Effect.provideService(InteractionService, interaction(true))),
    );

    expect(failureOf(exit)).toBeInstanceOf(PrivilegeCredentialsRequiredError);
    expect(spawns.map(argvOf)).toEqual([[SUDO, "-n", "-v"]]);
  });

  test("a refused password is an authorization failure carrying sudo's exit code", async () => {
    const { runner } = recordingRunner((spawn) =>
      spawn.args.join(" ") === "-v" || credentialCheck(spawn) ? 1 : 0,
    );
    const service = makePrivilegeService(runner, { host: host() });

    const exit = await Effect.runPromiseExit(
      service
        .ensureCredentials("install uidmap")
        .pipe(Effect.provideService(InteractionService, interaction(true))),
    );

    const failure = failureOf(exit);
    expect(failure).toBeInstanceOf(PrivilegeAuthorizationFailedError);
    expect(failure instanceof PrivilegeAuthorizationFailedError ? failure.exitCode : undefined).toBe(1);
  });

  test("SUDO_ASKPASS authorizes and runs with sudo -A, passing only that variable", async () => {
    const { runner, spawns } = recordingRunner(() => 0);
    const askpassHost = host({ env: { SUDO_ASKPASS: "/opt/askpass" }, isExecutableFile: () => true });
    const service = makePrivilegeService(runner, { host: askpassHost });

    await Effect.runPromise(
      service.ensureCredentials("install uidmap").pipe(Effect.andThen(service.elevate(["/bin/true"]))),
    );

    expect(spawns.map(argvOf)).toEqual([
      [SUDO, "-A", "-v"],
      [SUDO, "-A", "--", "/bin/true"],
    ]);
    expect(spawns.map((spawn) => spawn.env)).toEqual([
      { SUDO_ASKPASS: "/opt/askpass" },
      { SUDO_ASKPASS: "/opt/askpass" },
    ]);
  });

  test("root runs the argv itself", async () => {
    const { runner, spawns } = recordingRunner(() => 0);
    const service = makePrivilegeService(runner, { host: host({ euid: () => 0 }) });

    await Effect.runPromise(
      service.ensureCredentials("x").pipe(Effect.andThen(service.elevate(["/bin/true", "a"]))),
    );

    expect(spawns.map(argvOf)).toEqual([["/bin/true", "a"]]);
  });

  test("a sudo that cannot start is unavailable, not a missing password", async () => {
    const runner = ProcessRunner.of({
      run: (spawn) =>
        Effect.fail(new ProcessExecError({ message: "ENOENT", cmd: spawn.cmd, remediation: "install" })),
      stream: () => Effect.die("unused") as never,
      streamWithExit: () => Effect.die("unused") as never,
    });
    const service = makePrivilegeService(runner, { host: host() });

    const exit = await Effect.runPromiseExit(service.elevate(["/bin/true"]));

    expect(failureOf(exit)?._tag).toBe("PrivilegeUnavailableError");
  });

  test("Ctrl-C at the prompt lets sudo exit by itself, then surfaces as interruption", async () => {
    // Given sudo is waiting for a password on the terminal.
    const started = Effect.runSync(Deferred.make<void>());
    const answered = Effect.runSync(Deferred.make<void>());
    let sudoReturned = false;
    const runner = ProcessRunner.of({
      run: (spawn) =>
        credentialCheck(spawn)
          ? Effect.succeed({ exitCode: 1, stdout: "", stderr: "" })
          : Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(answered)),
              Effect.map(() => {
                sudoReturned = true;
                return { exitCode: 1, stdout: "", stderr: "" };
              }),
            ),
      stream: () => Effect.die("unused") as never,
      streamWithExit: () => Effect.die("unused") as never,
    });
    const service = makePrivilegeService(runner, { host: host() });

    // When the command is interrupted while sudo owns the terminal, and sudo then exits.
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          service
            .ensureCredentials("install uidmap")
            .pipe(Effect.provideService(InteractionService, interaction(true))),
        );
        yield* Deferred.await(started);
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber));
        yield* Deferred.succeed(answered, undefined);
        yield* Fiber.join(interrupting);
        return yield* Fiber.await(fiber);
      }),
    );

    // Then sudo was not killed mid-prompt, and the result is an interruption, not a refusal.
    expect(sudoReturned).toBe(true);
    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(failureOf(exit)).toBeUndefined();
  });

  test.each([
    ["the credential prompt", (spec: ReturnType<typeof makePrivilegeService>) => spec.ensureCredentials("x")],
    [
      "an elevated command",
      (spec: ReturnType<typeof makePrivilegeService>) => spec.elevate(["/usr/bin/apt-get", "update"]),
    ],
  ] as const)(
    "sudo ending by SIGINT at %s is an interruption even before Lando sees the signal",
    async (_name, call) => {
      // Given the terminal's SIGINT reached sudo, but Lando's own handler has not run yet.
      const { runner } = recordingRunner((spawn) => (credentialCheck(spawn) ? 1 : 130));
      const service = makePrivilegeService(runner, { host: host() });

      // When
      const exit = await Effect.runPromiseExit(
        call(service).pipe(Effect.provideService(InteractionService, interaction(true))),
      );

      // Then it is neither a sudo refusal nor a failed command.
      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(failureOf(exit)).toBeUndefined();
      expect(Exit.isSuccess(exit)).toBe(false);
    },
  );
});

describe.skipIf(process.platform !== "linux")("PrivilegeService with the real ProcessRunner", () => {
  test("sudo children share Lando's session, so a tty-scoped sudo ticket stays visible", async () => {
    // Given a fake sudo that records its argv and session id.
    const dir = await mkdtemp(join(tmpdir(), "lando-fake-sudo-"));
    const log = join(dir, "log");
    const fakeSudo = join(dir, "sudo");
    await writeFile(
      fakeSudo,
      `#!/bin/sh\nprintf '%s|%s\\n' "$(ps -o sid= -p $$ | tr -d ' ')" "$*" >> '${log}'\n`,
    );
    await chmod(fakeSudo, 0o755);
    try {
      const runner = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* ProcessRunner;
        }).pipe(Effect.provide(BunProcessRunner.layer)),
      );
      const service = makePrivilegeService(runner, {
        host: host({ which: () => fakeSudo, hasTerminal: () => false }),
      });

      // When
      await Effect.runPromise(service.elevate(["/bin/true", "x"]));

      // Then both invocations ran in this process's session with the exact argv.
      const ownSid = Bun.spawnSync(["ps", "-o", "sid=", "-p", String(process.pid)])
        .stdout.toString()
        .trim();
      const lines = (await readFile(log, "utf8")).trim().split("\n");
      expect(lines).toEqual([`${ownSid}|-n -v`, `${ownSid}|-n -- /bin/true x`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
