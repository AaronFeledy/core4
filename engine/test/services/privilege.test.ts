import { describe, expect, test } from "bun:test";

import {
  PrivilegeAuthorizationFailedError,
  PrivilegeCredentialsRequiredError,
  PrivilegeUnavailableError,
  ProcessExecError,
} from "@lando/sdk/errors";
import {
  EventService,
  InteractionService,
  type InteractionServiceShape,
  type ProcessResult,
  ProcessRunner,
  type ProcessSpawnOptions,
} from "@lando/sdk/services";
import { Cause, type Context, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as LandoEventService from "../../src/services/event-service";
import {
  type ElevationHost,
  type PrivilegeLayerOptions,
  elevationTransport,
  makePrivilegeService,
} from "../../src/services/privilege";

const SUDO = "/usr/bin/sudo";
const ok = (): ProcessResult => ({ exitCode: 0, stdout: "", stderr: "" });

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

const argvOf = (spawn: ProcessSpawnOptions) => [spawn.cmd, ...spawn.args].join(" ");
const isRefresh = (spawn: ProcessSpawnOptions) => spawn.args.join(" ") === "-n -v";

/**
 * Scripted sudo: `ticket` says whether `sudo -n -v` finds a ticket; a terminal `sudo -v` grants
 * one when `password` is right (and caching is allowed); `sudo -k` forgets it.
 */
const fakeSudo = (state: { ticket: boolean; password?: boolean; caching?: boolean }) => {
  const order: string[] = [];
  const spawns: ProcessSpawnOptions[] = [];
  const runner: Context.Service.Shape<typeof ProcessRunner> = ProcessRunner.of({
    run: (spawn) =>
      Effect.sync((): ProcessResult => {
        spawns.push(spawn);
        order.push(argvOf(spawn));
        const args = spawn.args.join(" ");
        if (isRefresh(spawn)) return { ...ok(), exitCode: state.ticket ? 0 : 1 };
        if (args === "-v" || args === "-A -v") {
          if (state.password === false) return { ...ok(), exitCode: 1 };
          state.ticket = state.caching !== false;
          return ok();
        }
        if (args === "-k") state.ticket = false;
        return ok();
      }),
    stream: () => Effect.die("unused") as never,
    streamWithExit: () => Effect.die("unused") as never,
  });
  return { runner, spawns, order, state };
};

const recordingHandoff = (order: string[]): NonNullable<PrivilegeLayerOptions["handoff"]> => ({
  suspend: (body) =>
    Effect.sync(() => void order.push("suspend")).pipe(
      Effect.andThen(body),
      Effect.ensuring(Effect.sync(() => void order.push("resume"))),
    ),
});

const announcingEvents = (order: string[]) =>
  Layer.effect(
    EventService,
    Effect.gen(function* () {
      const events = yield* EventService;
      return EventService.of({
        ...events,
        publish: (event) =>
          Effect.sync(() => void order.push(`announce: ${String(Reflect.get(event, "body"))}`)),
      });
    }),
  ).pipe(Layer.provide(LandoEventService.layer));

const failureOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.findErrorOption(exit.cause);
  return failure._tag === "Some" ? failure.value : undefined;
};

const inRun = <A, E>(
  effect: Effect.Effect<A, E, InteractionService | EventService>,
  interactive: boolean,
  order: string[] = [],
) =>
  effect.pipe(
    Effect.provideService(InteractionService, interaction(interactive)),
    Effect.provide(announcingEvents(order)),
  );

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

describe("PrivilegeService.credentialStatus", () => {
  test.each([
    ["root", host({ euid: () => 0 }), { ticket: false }, true, "root"],
    ["no adapter", host({ platform: "win32" }), { ticket: false }, true, "unavailable"],
    [
      "askpass",
      host({ env: { SUDO_ASKPASS: "/a" }, isExecutableFile: () => true }),
      { ticket: false },
      true,
      "askpass",
    ],
    ["a valid ticket", host(), { ticket: true }, false, "cached"],
    ["a terminal run without a ticket", host(), { ticket: false }, true, "will-prompt"],
    ["a run that cannot ask", host(), { ticket: false }, false, "required"],
  ] as const)("reports %s without prompting", async (_name, candidate, ticket, interactive, expected) => {
    const sudo = fakeSudo({ ...ticket });
    const service = makePrivilegeService(sudo.runner, { host: candidate });

    const status = await Effect.runPromise(inRun(service.credentialStatus, interactive));

    expect(status.state).toBe(expected);
    expect(sudo.order.every((line) => !line.endsWith(" -v") || line.endsWith("-n -v"))).toBe(true);
  });
});

describe("PrivilegeService sessions", () => {
  test("a run that cannot ask and has no ticket fails before any command runs", async () => {
    const sudo = fakeSudo({ ticket: false });
    const service = makePrivilegeService(sudo.runner, { host: host() });

    const exit = await Effect.runPromiseExit(
      inRun(Effect.scoped(service.openSession("install uidmap")), false),
    );

    const failure = failureOf(exit);
    expect(failure).toBeInstanceOf(PrivilegeCredentialsRequiredError);
    expect(failure?.remediation).toContain("sudo -v");
    expect(failure?.remediation).toContain("SUDO_ASKPASS");
    expect(sudo.order).toEqual([`${SUDO} -n -v`]);
  });

  test("a user's own ticket is reused without the terminal and is never forgotten", async () => {
    const sudo = fakeSudo({ ticket: true });
    const order = sudo.order;
    const service = makePrivilegeService(sudo.runner, { host: host(), handoff: recordingHandoff(order) });
    const stdin = new TextEncoder().encode("delegate");

    await Effect.runPromise(
      inRun(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* service.openSession("install uidmap");
            expect(session.transport).toBe("cached");
            yield* session.elevate(["/usr/bin/tee", "/etc/x"], { stdin });
          }),
        ),
        true,
        order,
      ),
    );

    expect(order).toEqual([`${SUDO} -n -v`, `${SUDO} -n -v`, `${SUDO} -n -- /usr/bin/tee /etc/x`]);
    expect(sudo.spawns.at(-1)?.stdin).toEqual(stdin);
    // A private capture is spawned detached in a new session, where sudo's tty ticket is invisible.
    expect(sudo.spawns.every((spawn) => spawn.capture !== true)).toBe(true);
  });

  test("an interactive run announces, lends the terminal to one sudo prompt, and forgets that ticket", async () => {
    const sudo = fakeSudo({ ticket: false });
    const order = sudo.order;
    const service = makePrivilegeService(sudo.runner, { host: host(), handoff: recordingHandoff(order) });

    await Effect.runPromise(
      inRun(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* service.openSession("install uidmap");
            expect(session.transport).toBe("prompted");
            yield* session.elevate(["/usr/bin/apt-get", "update"]);
            yield* session.elevate(["/usr/sbin/usermod", "-a"]);
          }),
        ),
        true,
        order,
      ),
    );

    expect(order).toEqual([
      `${SUDO} -n -v`,
      "announce: Lando needs administrator access to install uidmap. sudo asks for your password next.",
      "suspend",
      `${SUDO} -v`,
      "resume",
      `${SUDO} -n -v`,
      `${SUDO} -n -v`,
      `${SUDO} -n -- /usr/bin/apt-get update`,
      `${SUDO} -n -v`,
      `${SUDO} -n -- /usr/sbin/usermod -a`,
      `${SUDO} -k`,
    ]);
    const prompt = sudo.spawns.find((spawn) => spawn.args.join(" ") === "-v");
    expect(prompt?.inheritStdin).toBe(true);
    expect(prompt?.inheritOutput).toBe(true);
  });

  test("an interactive invocation without real terminals never prompts", async () => {
    const sudo = fakeSudo({ ticket: false });
    const service = makePrivilegeService(sudo.runner, { host: host({ hasTerminal: () => false }) });

    const exit = await Effect.runPromiseExit(
      inRun(Effect.scoped(service.openSession("install uidmap")), true),
    );

    expect(failureOf(exit)).toBeInstanceOf(PrivilegeCredentialsRequiredError);
    expect(sudo.order).toEqual([`${SUDO} -n -v`]);
  });

  test("a refused password is an authorization failure carrying sudo's exit code", async () => {
    const sudo = fakeSudo({ ticket: false, password: false });
    const service = makePrivilegeService(sudo.runner, { host: host() });

    const exit = await Effect.runPromiseExit(
      inRun(Effect.scoped(service.openSession("install uidmap")), true),
    );

    const failure = failureOf(exit);
    expect(failure).toBeInstanceOf(PrivilegeAuthorizationFailedError);
    expect(failure instanceof PrivilegeAuthorizationFailedError ? failure.exitCode : undefined).toBe(1);
  });

  test("a ticket lost mid-run is asked for again on the terminal, or fails a run that cannot ask", async () => {
    const lostTicket = async (interactive: boolean) => {
      const state = { ticket: true };
      const sudo = fakeSudo(state);
      const service = makePrivilegeService(sudo.runner, {
        host: host(),
        handoff: recordingHandoff(sudo.order),
      });
      const exit = await Effect.runPromiseExit(
        inRun(
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* service.openSession("install uidmap");
              state.ticket = false;
              yield* session.elevate(["/usr/bin/apt-get", "update"]);
            }),
          ),
          interactive,
          sudo.order,
        ),
      );
      return { exit, order: sudo.order };
    };

    const asked = await lostTicket(true);
    expect(Exit.isSuccess(asked.exit)).toBe(true);
    expect(asked.order.slice(1)).toEqual([
      `${SUDO} -n -v`,
      "announce: Lando needs administrator access to install uidmap. sudo asks for your password next.",
      "suspend",
      `${SUDO} -v`,
      "resume",
      `${SUDO} -n -- /usr/bin/apt-get update`,
      `${SUDO} -k`,
    ]);

    const refused = await lostTicket(false);
    expect(failureOf(refused.exit)?.message).toContain("lost its sudo credentials");
    expect(refused.order).not.toContain(`${SUDO} -n -- /usr/bin/apt-get update`);
  });

  test("sudoers without a ticket cache asks on the terminal per command and refuses piped input", async () => {
    const sudo = fakeSudo({ ticket: false, caching: false });
    const order = sudo.order;
    const service = makePrivilegeService(sudo.runner, { host: host(), handoff: recordingHandoff(order) });

    const exit = await Effect.runPromiseExit(
      inRun(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* service.openSession("install uidmap");
            expect(session.transport).toBe("uncached");
            order.length = 0;
            yield* session.elevate(["/usr/bin/apt-get", "update"]);
            yield* session.elevate(["/usr/bin/tee", "/etc/x"], {
              stdin: new Uint8Array([1]),
            });
          }),
        ),
        true,
        order,
      ),
    );

    expect(order.slice(0, 4)).toEqual([
      "announce: Lando needs administrator access to run apt-get. sudo asks for your password next.",
      "suspend",
      `${SUDO} -- /usr/bin/apt-get update`,
      "resume",
    ]);
    expect(failureOf(exit)).toBeInstanceOf(PrivilegeUnavailableError);
    expect(order).not.toContain(`${SUDO} -- /usr/bin/tee /etc/x`);
  });

  test("SUDO_ASKPASS authorizes and runs with sudo -A, passing only that variable", async () => {
    const sudo = fakeSudo({ ticket: false });
    const askpassHost = host({ env: { SUDO_ASKPASS: "/opt/askpass" }, isExecutableFile: () => true });
    const service = makePrivilegeService(sudo.runner, { host: askpassHost });

    await Effect.runPromise(service.elevate(["/bin/true"]));

    expect(sudo.order).toEqual([`${SUDO} -n -v`, `${SUDO} -A -v`, `${SUDO} -A -- /bin/true`, `${SUDO} -k`]);
    expect(sudo.spawns.slice(1, 3).map((spawn) => spawn.env)).toEqual([
      { SUDO_ASKPASS: "/opt/askpass" },
      { SUDO_ASKPASS: "/opt/askpass" },
    ]);
  });

  test("SUDO_ASKPASS keeps a ticket the user already had, for a session and a one-off command alike", async () => {
    // Given the user's own `sudo -v` ticket.
    const sudo = fakeSudo({ ticket: true });
    const askpassHost = host({ env: { SUDO_ASKPASS: "/opt/askpass" }, isExecutableFile: () => true });
    const service = makePrivilegeService(sudo.runner, { host: askpassHost });

    // When a session and a one-off command both use it.
    await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(service.openSession("install uidmap"), (session) => session.elevate(["/bin/true"])),
      ),
    );
    await Effect.runPromise(service.elevate(["/bin/false"]));

    // Then askpass never ran and the ticket is still the user's.
    expect(sudo.order).not.toContain(`${SUDO} -A -v`);
    expect(sudo.order).not.toContain(`${SUDO} -k`);
    expect(sudo.order.filter((line) => line.includes(" -A -- "))).toEqual([
      `${SUDO} -A -- /bin/true`,
      `${SUDO} -A -- /bin/false`,
    ]);
  });

  test("SUDO_ASKPASS forgets the ticket it made when the user's expired mid-session", async () => {
    // Given a ticket that expires after the session opens.
    const sudo = fakeSudo({ ticket: true });
    const askpassHost = host({ env: { SUDO_ASKPASS: "/opt/askpass" }, isExecutableFile: () => true });
    const service = makePrivilegeService(sudo.runner, { host: askpassHost });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* service.openSession("install uidmap");
          yield* Effect.sync(() => {
            sudo.state.ticket = false;
          });
          yield* session.elevate(["/bin/true"]);
        }),
      ),
    );

    // Then the command's askpass authorization is Lando's to forget.
    expect(sudo.order.at(-1)).toBe(`${SUDO} -k`);
  });

  test("root runs the argv itself, with its input", async () => {
    const sudo = fakeSudo({ ticket: false });
    const service = makePrivilegeService(sudo.runner, { host: host({ euid: () => 0 }) });
    const stdin = new Uint8Array([7]);

    await Effect.runPromise(service.elevate(["/bin/true", "a"], { stdin }));

    expect(sudo.order).toEqual(["/bin/true a"]);
    expect(sudo.spawns[0]?.stdin).toEqual(stdin);
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
});

describe("PrivilegeService keep-alive", () => {
  test("an open session refreshes its ticket every interval until a refresh fails", async () => {
    const state = { ticket: true };
    const sudo = fakeSudo(state);
    const service = makePrivilegeService(sudo.runner, { host: host(), keepAliveIntervalMs: 60_000 });
    const refreshes = () => sudo.spawns.filter(isRefresh);

    await Effect.runPromise(
      inRun(
        Effect.scoped(
          Effect.gen(function* () {
            yield* service.openSession("install uidmap");
            expect(refreshes()).toHaveLength(1);
            yield* TestClock.adjust("60 seconds");
            yield* TestClock.adjust("60 seconds");
            expect(refreshes()).toHaveLength(3);
            expect(refreshes().at(-1)?.timeoutMs).toBe(15_000);
            state.ticket = false;
            yield* TestClock.adjust("60 seconds");
            yield* TestClock.adjust("60 seconds");
            yield* TestClock.adjust("60 seconds");
            expect(refreshes()).toHaveLength(4);
          }),
        ),
        false,
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });
});

describe("PrivilegeService interruption", () => {
  /** A handoff whose body finishes (sudo granted the ticket) and is then interrupted. */
  const interruptedAfterPrompt: NonNullable<PrivilegeLayerOptions["handoff"]> = {
    suspend: (body) => Effect.andThen(body, Effect.interrupt),
  };

  test("an interrupt right after the prompt still forgets the ticket the prompt made", async () => {
    // Given sudo grants a ticket at the prompt, and the run is interrupted the moment it returns.
    const sudo = fakeSudo({ ticket: false });
    const service = makePrivilegeService(sudo.runner, { host: host(), handoff: interruptedAfterPrompt });

    // When the session opens.
    const exit = await Effect.runPromiseExit(
      inRun(Effect.scoped(service.openSession("install uidmap")), true),
    );

    // Then the ticket Lando made does not outlive the run.
    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(sudo.order.at(-1)).toBe(`${SUDO} -k`);
  });

  test("an interrupt right after asking again for a lost ticket still forgets it", async () => {
    // Given the user's own ticket lapses mid-session and the second prompt is interrupted after it.
    const state = { ticket: true };
    const sudo = fakeSudo(state);
    const service = makePrivilegeService(sudo.runner, { host: host(), handoff: interruptedAfterPrompt });

    const exit = await Effect.runPromiseExit(
      inRun(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* service.openSession("install uidmap");
            state.ticket = false;
            yield* session.elevate(["/usr/bin/apt-get", "update"]);
          }),
        ),
        true,
      ),
    );

    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(sudo.order.at(-1)).toBe(`${SUDO} -k`);
  });

  test("an interrupt right after askpass authorizes still forgets the ticket it made", async () => {
    // Given askpass grants a ticket and the run is interrupted as `sudo -A -v` returns.
    const state = { ticket: false };
    const base = fakeSudo(state);
    const runner = ProcessRunner.of({
      ...base.runner,
      run: (spawn) =>
        spawn.args.join(" ") === "-A -v"
          ? Effect.andThen(base.runner.run(spawn), Effect.interrupt)
          : base.runner.run(spawn),
    });
    const askpassHost = host({ env: { SUDO_ASKPASS: "/opt/askpass" }, isExecutableFile: () => true });
    const service = makePrivilegeService(runner, { host: askpassHost });

    const exit = await Effect.runPromiseExit(Effect.scoped(service.openSession("install uidmap")));

    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(base.order.at(-1)).toBe(`${SUDO} -k`);
  });

  test("Ctrl-C at the prompt lets sudo exit by itself, then surfaces as interruption", async () => {
    // Given sudo is waiting for a password on the terminal.
    const started = Effect.runSync(Deferred.make<void>());
    const answered = Effect.runSync(Deferred.make<void>());
    let sudoReturned = false;
    const runner = ProcessRunner.of({
      run: (spawn) =>
        isRefresh(spawn) || spawn.args.join(" ") === "-k"
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
          inRun(Effect.scoped(service.openSession("install uidmap")), true),
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

  test("sudo ending by SIGINT at the prompt is an interruption even before Lando sees the signal", async () => {
    const runner = ProcessRunner.of({
      run: (spawn) => Effect.succeed({ ...ok(), exitCode: isRefresh(spawn) ? 1 : 130 }),
      stream: () => Effect.die("unused") as never,
      streamWithExit: () => Effect.die("unused") as never,
    });
    const service = makePrivilegeService(runner, { host: host() });

    const exit = await Effect.runPromiseExit(inRun(Effect.scoped(service.openSession("x")), true));

    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(failureOf(exit)).toBeUndefined();
  });
});
