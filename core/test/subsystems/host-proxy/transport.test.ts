import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Exit, Layer } from "effect";

import {
  HostProxyAuthenticationError,
  HostProxyBackpressureError,
  HostProxyCommandNotAllowedError,
  HostProxyRecursionError,
  HostProxySocketStaleError,
  HostProxyTransportUnavailableError,
} from "@lando/sdk/errors";
import { AbsolutePath, type CommandResultEnvelope } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";

import { RedactionService, createStandaloneRedactor } from "../../../src/redaction/service.ts";
import type {
  HostProxyRunLandoExecutor,
  HostProxyRunLandoExecutorInput,
} from "../../../src/subsystems/host-proxy/dispatch.ts";
import {
  defaultHostProxyShimArtifactPath,
  resolveHostProxyShimArtifactPath,
} from "../../../src/subsystems/host-proxy/transport-shim.ts";
import {
  HOST_PROXY_SHIM_SOURCE,
  createHostProxyRunLandoSession,
  hostProxyRunLandoStateDir,
  scopedHostProxyRunLandoSession,
  sendHostProxyRunLando,
} from "../../../src/subsystems/host-proxy/transport.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const tempRoot = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-host-proxy-"));
  tempDirs.push(dir);
  return dir;
};

const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make("/srv/apps/demo") };
const mount = { containerRoot: "/app", hostRoot: "/srv/apps/demo" };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const coreBuildHostProxyShimScript = async (): Promise<string> => {
  const packageJson: unknown = await Bun.file(join(import.meta.dirname, "../../../package.json")).json();
  if (!isRecord(packageJson) || !isRecord(packageJson.scripts)) throw new Error("Invalid core package.json");
  const script = packageJson.scripts["build:host-proxy-shim"];
  if (typeof script !== "string") throw new Error("Missing build:host-proxy-shim script");
  return script;
};

const envelope: CommandResultEnvelope = {
  apiVersion: "v4",
  command: "app:open",
  ok: true,
  result: { app: "demo", targets: [], launch: "printed" },
  warnings: [],
  deprecations: [],
};

const redactionLayer = Layer.succeed(RedactionService, {
  forProfile: (profile, options) => Effect.succeed(createStandaloneRedactor(profile, options)),
});

type CapturedEvent = { readonly _tag: string; readonly outcome?: string; readonly failureDetail?: string };

const eventLayerFor = (events: CapturedEvent[] = []) =>
  Layer.succeed(EventService, {
    publish: (event: CapturedEvent) =>
      Effect.sync(() => {
        events.push(event);
      }),
    subscribe: () => Effect.die("unused"),
    waitFor: () => Effect.die("unused"),
  } as never);

const runWithEvents = <Value, Error>(
  program: Effect.Effect<Value, Error, EventService | RedactionService>,
  events: CapturedEvent[],
) => Effect.runPromise(program.pipe(Effect.provide(Layer.mergeAll(redactionLayer, eventLayerFor(events)))));

const runExitWithEvents = <Value, Error>(
  program: Effect.Effect<Value, Error, EventService | RedactionService>,
  events: CapturedEvent[],
) =>
  Effect.runPromiseExit(program.pipe(Effect.provide(Layer.mergeAll(redactionLayer, eventLayerFor(events)))));

const unusedEventLayer = Layer.succeed(EventService, {
  publish: () => Effect.void,
  subscribe: () => Effect.die("unused"),
  waitFor: () => Effect.die("unused"),
} as never);

const run = <Value, Error>(program: Effect.Effect<Value, Error, EventService | RedactionService>) =>
  Effect.runPromise(program.pipe(Effect.provide(Layer.mergeAll(redactionLayer, unusedEventLayer))));

const runExit = <Value, Error>(program: Effect.Effect<Value, Error, EventService | RedactionService>) =>
  Effect.runPromiseExit(program.pipe(Effect.provide(Layer.mergeAll(redactionLayer, unusedEventLayer))));

const sessionFor = async (
  executor: HostProxyRunLandoExecutor,
  overrides: { readonly concurrency?: number; readonly shimArtifactPath?: string } = {},
) => {
  const shimArtifactPath = overrides.shimArtifactPath ?? (await fakeExecutable());
  return run(
    createHostProxyRunLandoSession({
      app,
      mountInfo: mount,
      allowlist: ["app:open"],
      callerService: "web",
      executor,
      paths: { userCacheRoot: await tempRoot(), userDataRoot: await tempRoot() },
      ...(overrides.concurrency === undefined ? {} : { concurrency: overrides.concurrency }),
      shimArtifactPath,
    }),
  );
};

const fakeExecutable = async (): Promise<string> => {
  const path = join(await tempRoot(), "lando-shim");
  await writeFile(path, "#!/usr/bin/env sh\nexit 0\n");
  await chmod(path, 0o755);
  return path;
};

const compiledShimArtifact = async (): Promise<string> => {
  const output = join(await tempRoot(), "lando-shim");
  const proc = Bun.spawn({
    cmd: [process.execPath, "build", HOST_PROXY_SHIM_SOURCE, "--compile", "--outfile", output],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exitCode !== 0) throw new Error(stderr);
  return output;
};

const compiledReleaseBinary = async (): Promise<string> => {
  const output = join(await tempRoot(), "lando");
  const proc = Bun.spawn({
    cmd: [process.execPath, "build", "core/bin/lando.ts", "--compile", "--outfile", output],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exitCode !== 0) throw new Error(stderr);
  return output;
};

const expectMissingPath = async (path: string): Promise<void> => {
  try {
    await stat(path);
  } catch (cause) {
    if (cause instanceof Error) return;
    throw cause;
  }
  throw new Error(`Expected ${path} to be removed.`);
};

describe("host-proxy runLando physical transport", () => {
  test("selects deterministic compiled shim sidecars for supported container targets", () => {
    const distRoot = "/opt/lando/core/dist";

    expect(
      resolveHostProxyShimArtifactPath({
        distRoot,
        target: { os: "linux", arch: "x64" },
      }),
    ).toBe("/opt/lando/core/dist/host-proxy/linux-x64/lando-shim");
    expect(
      resolveHostProxyShimArtifactPath({
        distRoot,
        target: { os: "linux", arch: "arm64" },
      }),
    ).toBe("/opt/lando/core/dist/host-proxy/linux-arm64/lando-shim");
  });

  test("build script delivers every supported compiled shim sidecar path", async () => {
    const script = await coreBuildHostProxyShimScript();

    expect(script).toContain("--target=bun-linux-x64 --outfile ./dist/host-proxy/linux-x64/lando-shim");
    expect(script).toContain("--target=bun-linux-arm64 --outfile ./dist/host-proxy/linux-arm64/lando-shim");
  });

  test("happy authenticated physical round trip preserves envelope and remapped cwd", async () => {
    let capturedCwd = "";
    const session = await sessionFor((input) => {
      capturedCwd = input.cwd;
      return Effect.succeed({ envelope, exitCode: 0 });
    });

    const result = await run(
      sendHostProxyRunLando(session, { argv: ["open", "--print"], cwd: "/app/web", tty: false }),
    );

    expect(result).toEqual({ envelope, exitCode: 0 });
    expect(capturedCwd).toBe("/srv/apps/demo/web");
    await session.close();
  });

  test("tcp host-gateway sessions use the URL client path and close their listener state", async () => {
    let capturedCwd = "";
    const cacheRoot = await tempRoot();
    const dataRoot = await tempRoot();
    const session = await run(
      createHostProxyRunLandoSession({
        app,
        mountInfo: mount,
        allowlist: ["app:open"],
        callerService: "web",
        executor: (input) => {
          capturedCwd = input.cwd;
          return Effect.succeed({ envelope, exitCode: 0 });
        },
        paths: { platform: "win32", userCacheRoot: cacheRoot, userDataRoot: dataRoot },
        hostGatewayName: "host.containers.internal",
        shimArtifactPath: await fakeExecutable(),
      }),
    );

    expect(session.transport).toBe("tcp-host-gateway");
    expect(session.socketPath).toBeUndefined();
    expect(session.url).toStartWith("http://127.0.0.1:");
    expect(session.url).not.toContain("0.0.0.0");
    expect(session.containerUrl).toStartWith("http://host.containers.internal:");
    expect(
      await run(sendHostProxyRunLando(session, { argv: ["open"], cwd: "/app/web", tty: false })),
    ).toEqual({
      envelope,
      exitCode: 0,
    });
    expect(capturedCwd).toBe("/srv/apps/demo/web");

    const stateDir = hostProxyRunLandoStateDir(app, { platform: "win32", userDataRoot: dataRoot });
    await session.close();
    await expectMissingPath(stateDir);
  });

  test("rejects missing, stale, and cross-app tokens with tagged failures", async () => {
    const session = await sessionFor(() => Effect.succeed({ envelope, exitCode: 0 }));

    const missing = await runExit(
      sendHostProxyRunLando({ ...session, token: "" }, { argv: ["open"], cwd: "/app", tty: false }),
    );
    const stale = await runExit(
      sendHostProxyRunLando({ ...session, token: "stale" }, { argv: ["open"], cwd: "/app", tty: false }),
    );
    const crossApp = await runExit(
      sendHostProxyRunLando({ ...session, appId: "other" }, { argv: ["open"], cwd: "/app", tty: false }),
    );

    expect(Exit.isFailure(missing)).toBe(true);
    expect(Exit.isFailure(stale)).toBe(true);
    expect(Exit.isFailure(crossApp)).toBe(true);
    if (Exit.isFailure(missing) && missing.cause._tag === "Fail") {
      expect(missing.cause.error).toBeInstanceOf(HostProxyAuthenticationError);
      if (missing.cause.error instanceof HostProxyAuthenticationError)
        expect(missing.cause.error.reason).toBe("missing");
    }
    if (Exit.isFailure(stale) && stale.cause._tag === "Fail") {
      expect(stale.cause.error).toBeInstanceOf(HostProxyAuthenticationError);
      if (stale.cause.error instanceof HostProxyAuthenticationError)
        expect(stale.cause.error.reason).toBe("stale");
    }
    if (Exit.isFailure(crossApp) && crossApp.cause._tag === "Fail") {
      expect(crossApp.cause.error).toBeInstanceOf(HostProxyAuthenticationError);
      if (crossApp.cause.error instanceof HostProxyAuthenticationError)
        expect(crossApp.cause.error.reason).toBe("cross-app");
    }
    await session.close();
  });

  test("rejects recursion and immediate saturation", async () => {
    let release: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = await sessionFor(
      () => Effect.promise(() => blocker).pipe(Effect.as({ envelope, exitCode: 0 })),
      {
        concurrency: 1,
      },
    );

    const recursion = await runExit(
      sendHostProxyRunLando(session, { argv: ["open"], cwd: "/app", tty: false }, { depth: 3 }),
    );
    const first = run(sendHostProxyRunLando(session, { argv: ["open"], cwd: "/app", tty: false }));
    const saturated = await runExit(
      sendHostProxyRunLando(session, { argv: ["open"], cwd: "/app", tty: false }),
    );

    expect(Exit.isFailure(recursion)).toBe(true);
    if (Exit.isFailure(recursion) && recursion.cause._tag === "Fail") {
      expect(recursion.cause.error).toBeInstanceOf(HostProxyRecursionError);
    }
    expect(Exit.isFailure(saturated)).toBe(true);
    if (Exit.isFailure(saturated) && saturated.cause._tag === "Fail") {
      expect(saturated.cause.error).toBeInstanceOf(HostProxyBackpressureError);
    }
    release?.();
    await first;
    await session.close();
  });

  test("decodes command-not-allowed as HostProxyCommandNotAllowedError", async () => {
    const session = await run(
      createHostProxyRunLandoSession({
        app,
        mountInfo: mount,
        allowlist: [],
        callerService: "web",
        executor: () => Effect.succeed({ envelope, exitCode: 0 }),
        paths: { userCacheRoot: await tempRoot(), userDataRoot: await tempRoot() },
        shimArtifactPath: await fakeExecutable(),
      }),
    );

    const exit = await runExit(sendHostProxyRunLando(session, { argv: ["open"], cwd: "/app", tty: false }));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(HostProxyCommandNotAllowedError);
    }
    await session.close();
  });

  test("serves authenticated requests over a scoped Windows TCP bridge endpoint", async () => {
    const session = await run(
      createHostProxyRunLandoSession({
        app,
        mountInfo: mount,
        allowlist: ["app:open"],
        callerService: "web",
        executor: () => Effect.succeed({ envelope, exitCode: 0 }),
        paths: { userCacheRoot: await tempRoot(), userDataRoot: await tempRoot(), platform: "win32" },
        hostGatewayName: "host.containers.internal",
        shimArtifactPath: await fakeExecutable(),
      }),
    );

    const result = await run(sendHostProxyRunLando(session, { argv: ["open"], cwd: "/app", tty: false }));

    expect(session.socketPath).toBeUndefined();
    expect(session.url).toStartWith("http://127.0.0.1:");
    expect(session.containerUrl).toStartWith("http://host.containers.internal:");
    expect(result).toEqual({ envelope, exitCode: 0 });
    await session.close();
  });

  test("fails closed when a stale socket path already exists", async () => {
    const paths = { userCacheRoot: await tempRoot(), userDataRoot: await tempRoot() };
    const stateDir = hostProxyRunLandoStateDir(app, paths);
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "host-proxy.sock"), "stale");

    const exit = await runExit(
      createHostProxyRunLandoSession({
        app,
        mountInfo: mount,
        allowlist: ["app:open"],
        callerService: "web",
        executor: () => Effect.succeed({ envelope, exitCode: 0 }),
        paths,
        shimArtifactPath: await fakeExecutable(),
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(HostProxySocketStaleError);
    }
  });

  test("rejects malformed and oversized socket input without crashing the session", async () => {
    const events: CapturedEvent[] = [];
    const session = await runWithEvents(
      createHostProxyRunLandoSession({
        app,
        mountInfo: mount,
        allowlist: ["app:open"],
        callerService: "web",
        executor: () => Effect.succeed({ envelope, exitCode: 0 }),
        paths: { userCacheRoot: await tempRoot(), userDataRoot: await tempRoot() },
        shimArtifactPath: await fakeExecutable(),
      }),
      events,
    );
    const socketMode = (await stat(session.socketPath)).mode & 0o777;
    expect(socketMode).toBe(0o600);
    const headers = authHeaders(session);
    const malformed = await rawSocketExchange(session.socketPath, "{not-json}\n", headers);
    const oversized = await rawSocketExchange(
      session.socketPath,
      `${"x".repeat(1024 * 1024 + 1)}\n`,
      headers,
    );

    expect(malformed).toContain("HostProxyTransportUnavailableError");
    expect(oversized).toContain("HostProxyTransportUnavailableError");
    expect(events.map((event) => [event._tag, event.outcome, event.failureDetail])).toEqual([
      ["pre-host-proxy-call", undefined, undefined],
      ["post-host-proxy-call", "failure", "HostProxyTransportUnavailableError"],
      ["pre-host-proxy-call", undefined, undefined],
      ["post-host-proxy-call", "failure", "HostProxyTransportUnavailableError"],
    ]);

    const healthy = await run(sendHostProxyRunLando(session, { argv: ["open"], cwd: "/app", tty: false }));
    expect(healthy.exitCode).toBe(0);
    await session.close();
  });

  test("rejects an oversized request once and ignores bytes written after the limit", async () => {
    const events: CapturedEvent[] = [];
    let executions = 0;
    const session = await runWithEvents(
      createHostProxyRunLandoSession({
        app,
        mountInfo: mount,
        allowlist: ["app:open"],
        callerService: "web",
        executor: () => {
          executions += 1;
          return Effect.succeed({ envelope, exitCode: 0 });
        },
        paths: { userCacheRoot: await tempRoot(), userDataRoot: await tempRoot() },
        shimArtifactPath: await fakeExecutable(),
      }),
      events,
    );

    const rejected = await oversizedWriteThenContinue(session.socketPath, authHeaders(session));

    expect(rejected.body).toContain("HostProxyTransportUnavailableError");
    expect(rejected.body).not.toContain("app:open");
    expect(rejected.responseCount).toBe(1);
    expect(rejected.connectionClosed).toBe(true);
    expect(rejected.raw).toContain("Connection: close");
    expect(executions).toBe(0);
    expect(events.map((event) => [event._tag, event.outcome, event.failureDetail])).toEqual([
      ["pre-host-proxy-call", undefined, undefined],
      ["post-host-proxy-call", "failure", "HostProxyTransportUnavailableError"],
    ]);
    const healthy = await run(sendHostProxyRunLando(session, { argv: ["open"], cwd: "/app", tty: false }));
    expect(healthy.exitCode).toBe(0);
    expect(executions).toBe(1);
    await session.close();
  });

  test("does not oversubscribe a simultaneous burst beyond the configured concurrency", async () => {
    let running = 0;
    let maxRunning = 0;
    let accept: (() => void) | undefined;
    let release: (() => void) | undefined;
    const accepted = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = await sessionFor(
      () =>
        Effect.sync(() => {
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          accept?.();
        }).pipe(
          Effect.zipRight(Effect.promise(() => blocker)),
          Effect.ensuring(
            Effect.sync(() => {
              running -= 1;
            }),
          ),
          Effect.as({ envelope, exitCode: 0 }),
        ),
      { concurrency: 1 },
    );

    const first = runExit(sendHostProxyRunLando(session, { argv: ["open"], cwd: "/app", tty: false }));
    await accepted;
    const saturatedRequests = Array.from({ length: 7 }, () =>
      runExit(sendHostProxyRunLando(session, { argv: ["open"], cwd: "/app", tty: false })),
    );
    const saturatedBurst = await Promise.allSettled(saturatedRequests);
    release?.();
    const burst = [
      await Promise.resolve(first).then((value) => ({ status: "fulfilled" as const, value })),
      ...saturatedBurst,
    ];

    const exits = burst.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const saturated = exits.filter(
      (exit) =>
        Exit.isFailure(exit) &&
        exit.cause._tag === "Fail" &&
        exit.cause.error instanceof HostProxyBackpressureError,
    );
    expect(maxRunning).toBe(1);
    expect(saturated.length).toBeGreaterThan(0);
    await session.close();
  });

  test("rejects unauthenticated malformed input before parsing the body", async () => {
    const session = await sessionFor(() => Effect.succeed({ envelope, exitCode: 0 }), {
      shimArtifactPath: await fakeExecutable(),
    });

    const rejected = await rawHttpExchange(session.socketPath, "{not-json}\n");

    expect(rejected.statusCode).toBe(401);
    expect(rejected.body).toContain("HostProxyAuthenticationError");
    expect(rejected.body).not.toContain("Invalid host-proxy request");
    expect(rejected.body).toContain("missing");
    await session.close();
  });

  test("counts an authenticated slow body against concurrency before parsing completes", async () => {
    const session = await sessionFor(() => Effect.succeed({ envelope, exitCode: 0 }), {
      concurrency: 1,
      shimArtifactPath: await fakeExecutable(),
    });
    const slow = await openSlowAuthenticatedRequest(session.socketPath, authHeaders(session));

    const saturated = await rawHttpExchange(
      session.socketPath,
      JSON.stringify({ _tag: "runLando", argv: ["open"], cwd: "/app", tty: false }),
      authHeaders(session),
    );

    expect(saturated.statusCode).toBe(429);
    expect(saturated.body).toContain("HostProxyBackpressureError");
    slow.destroy();
    const healthy = await run(sendHostProxyRunLando(session, { argv: ["open"], cwd: "/app", tty: false }));
    expect(healthy.exitCode).toBe(0);
    await session.close();
  });

  test("close interrupts in-flight requests before unlinking artifacts", async () => {
    let accepted: (() => void) | undefined;
    let interrupted = false;
    const acceptedRequest = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const session = await sessionFor(
      () =>
        Effect.sync(() => accepted?.()).pipe(
          Effect.zipRight(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
          Effect.as({ envelope, exitCode: 0 }),
        ),
      { shimArtifactPath: await fakeExecutable() },
    );

    const inFlight = runExit(sendHostProxyRunLando(session, { argv: ["open"], cwd: "/app", tty: false }));
    await acceptedRequest;
    await session.close();
    const closed = await runExit(sendHostProxyRunLando(session, { argv: ["open"], cwd: "/app", tty: false }));

    expect(interrupted).toBe(true);
    await expectMissingPath(session.socketPath);
    expect(Exit.isFailure(closed)).toBe(true);
    const interruptedExit = await inFlight;
    expect(Exit.isFailure(interruptedExit)).toBe(true);
    if (Exit.isFailure(interruptedExit) && interruptedExit.cause._tag === "Fail") {
      expect(interruptedExit.cause.error).toBeInstanceOf(HostProxyTransportUnavailableError);
      const error = interruptedExit.cause.error;
      if (error instanceof HostProxyTransportUnavailableError)
        expect(error.socketPath).toBe(session.socketPath);
    }
  });

  test("cleans socket and shim artifacts on close and failed setup", async () => {
    const session = await sessionFor(() => Effect.succeed({ envelope, exitCode: 0 }));
    await stat(session.socketPath);
    await stat(session.shimPath);
    await session.close();

    await expectMissingPath(session.socketPath);
    await expectMissingPath(session.shimPath);

    const failedRoot = await tempRoot();
    const failedPaths = { userCacheRoot: await tempRoot(), userDataRoot: failedRoot };
    const failedStateDir = hostProxyRunLandoStateDir(app, failedPaths);
    await mkdir(failedStateDir, { recursive: true });
    await writeFile(join(failedStateDir, "host-proxy.sock"), "stale");
    const failed = await runExitWithEvents(
      createHostProxyRunLandoSession({
        app,
        mountInfo: mount,
        allowlist: ["app:open"],
        callerService: "web",
        executor: () => Effect.succeed({ envelope, exitCode: 0 }),
        paths: failedPaths,
        shimArtifactPath: await fakeExecutable(),
      }),
      [],
    );
    expect(Exit.isFailure(failed)).toBe(true);
    await expectMissingPath(join(failedStateDir, "lando"));
  });

  test("closes the listener when chmod fails after bind", async () => {
    const paths = { userCacheRoot: await tempRoot(), userDataRoot: await tempRoot() };
    const stateDir = hostProxyRunLandoStateDir(app, paths);
    let deleting = true;
    const remover = setInterval(() => {
      if (deleting) void rm(join(stateDir, "host-proxy.sock"), { force: true });
    }, 0);

    try {
      const failed = await runExit(
        createHostProxyRunLandoSession({
          app,
          mountInfo: mount,
          allowlist: ["app:open"],
          callerService: "web",
          executor: () => Effect.succeed({ envelope, exitCode: 0 }),
          paths,
          shimArtifactPath: await fakeExecutable(),
        }),
      );

      expect(Exit.isFailure(failed)).toBe(true);
      if (Exit.isFailure(failed) && failed.cause._tag === "Fail")
        expect(failed.cause.error).toBeInstanceOf(HostProxyTransportUnavailableError);
    } finally {
      deleting = false;
      clearInterval(remover);
    }
  });

  test("cleans socket and shim artifacts on Effect scope close", async () => {
    let socketPath = "";
    let shimPath = "";
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* scopedHostProxyRunLandoSession({
            app,
            mountInfo: mount,
            allowlist: ["app:open"],
            callerService: "web",
            executor: () => Effect.succeed({ envelope, exitCode: 0 }),
            paths: {
              userCacheRoot: yield* Effect.promise(() => tempRoot()),
              userDataRoot: yield* Effect.promise(() => tempRoot()),
            },
            shimArtifactPath: yield* Effect.promise(() => fakeExecutable()),
          });
          socketPath = session.socketPath;
          shimPath = session.shimPath;
          yield* Effect.promise(() => stat(session.socketPath));
          yield* Effect.promise(() => stat(session.shimPath));
        }),
      ),
    );

    await expectMissingPath(socketPath);
    await expectMissingPath(shimPath);
  });

  test("compiled shim has runtime isolation and forwards exact argv cwd tty and filtered env", async () => {
    let captured: HostProxyRunLandoExecutorInput | undefined;
    const session = await sessionFor(
      (request) => {
        captured = request;
        return Effect.succeed({ envelope, exitCode: 0 });
      },
      {
        shimArtifactPath: await compiledShimArtifact(),
      },
    );
    expect(HOST_PROXY_SHIM_SOURCE).toBe("core/src/subsystems/host-proxy/shim-bin.ts");

    const proc = Bun.spawn({
      cmd: [session.shimPath, "open", "--print"],
      cwd: "/tmp",
      env: {
        LANDO_HOST_PROXY_SOCKET: session.socketPath,
        LANDO_HOST_PROXY_TOKEN: session.token,
        LANDO_HOST_PROXY_SESSION: session.sessionId,
        LANDO_HOST_PROXY_APP: session.appId,
        LANDO_HOST_PROXY_CALLER: "web",
        LANG: "C.UTF-8",
        OPENCODE: "1",
        SECRET_TOKEN: "do-not-forward",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toContain('"ok":true');
    expect(await new Response(proc.stderr).text()).toBe("");
    expect(captured).toEqual({
      argv: ["open", "--print"],
      commandId: "app:open",
      cwd: "/srv/apps/demo",
      tty: false,
      env: {
        LANDO_HOST_PROXY_SOCKET: session.socketPath,
        LANDO_HOST_PROXY_TOKEN: session.token,
        LANDO_HOST_PROXY_SESSION: session.sessionId,
        LANDO_HOST_PROXY_APP: session.appId,
        LANDO_HOST_PROXY_CALLER: "web",
        LANDO_HOST_PROXY_DEPTH: "1",
        LANG: "C.UTF-8",
        OPENCODE: "1",
      },
    });
    await session.close();
  });

  test("release-shaped compiled binary supplies and executes the default host-proxy shim", async () => {
    const artifactPath = await compiledReleaseBinary();
    const shimArtifactPath = defaultHostProxyShimArtifactPath({
      env: {},
      execPath: artifactPath,
      target: { os: "linux", arch: "x64" },
    });
    await mkdir(dirname(shimArtifactPath), { recursive: true });
    const buildShim = Bun.spawn({
      cmd: [process.execPath, "build", HOST_PROXY_SHIM_SOURCE, "--compile", "--outfile", shimArtifactPath],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [buildExitCode, buildStderr] = await Promise.all([
      buildShim.exited,
      new Response(buildShim.stderr).text(),
    ]);
    expect(buildExitCode).toBe(0);
    expect(buildStderr).toBe("");
    expect(shimArtifactPath).toBe(join(dirname(artifactPath), "host-proxy", "linux-x64", "lando-shim"));

    let captured: HostProxyRunLandoExecutorInput | undefined;
    const session = await sessionFor(
      (request) => {
        captured = request;
        return Effect.succeed({ envelope, exitCode: 0 });
      },
      { shimArtifactPath },
    );

    const proc = Bun.spawn({
      cmd: [session.shimPath, "open", "--print"],
      cwd: "/tmp",
      env: {
        LANDO_HOST_PROXY_SOCKET: session.socketPath,
        LANDO_HOST_PROXY_TOKEN: session.token,
        LANDO_HOST_PROXY_SESSION: session.sessionId,
        LANDO_HOST_PROXY_APP: session.appId,
        LANDO_HOST_PROXY_CALLER: "web",
        LANG: "C.UTF-8",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toContain('"ok":true');
    expect(await new Response(proc.stderr).text()).toBe("");
    expect(captured?.argv).toEqual(["open", "--print"]);
    await session.close();
  });
});

const rawHttpExchange = (
  socketPath: string,
  payload: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ readonly statusCode: number | undefined; readonly body: string }> =>
  new Promise((resolveResponse, reject) => {
    let body = "";
    const req = httpRequest({ socketPath, method: "POST", path: "/runLando", headers }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolveResponse({ statusCode: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end(payload);
  });

const rawSocketExchange = async (
  socketPath: string,
  payload: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<string> => (await rawHttpExchange(socketPath, payload, headers)).body;

const openSlowAuthenticatedRequest = (
  socketPath: string,
  headers: Readonly<Record<string, string>>,
): Promise<ReturnType<typeof createConnection>> =>
  new Promise((resolveSocket, reject) => {
    const socket = createConnection({ path: socketPath });
    const headerLines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
    const requestHead = [
      "POST /runLando HTTP/1.1",
      "Host: localhost",
      "Content-Type: application/json",
      "Content-Length: 999999999",
      ...headerLines,
      "",
      "",
    ].join("\r\n");
    socket.once("connect", () => {
      socket.write(requestHead);
      resolveSocket(socket);
    });
    socket.once("error", reject);
  });

const oversizedWriteThenContinue = (
  socketPath: string,
  headers: Readonly<Record<string, string>>,
): Promise<{
  readonly body: string;
  readonly raw: string;
  readonly responseCount: number;
  readonly connectionClosed: boolean;
}> =>
  new Promise((resolveResponse, reject) => {
    let raw = "";
    let settled = false;
    const resolveOnce = (): void => {
      if (settled) return;
      settled = true;
      resolveResponse({
        raw,
        body: raw.includes("\r\n\r\n") ? raw.slice(raw.indexOf("\r\n\r\n") + 4) : "",
        responseCount: raw.split("HTTP/1.1 ").length - 1,
        connectionClosed: socket.closed,
      });
    };
    const socket = createConnection({ path: socketPath });
    const headerLines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
    const payloadAfterLimit = JSON.stringify({ _tag: "runLando", argv: ["open"], cwd: "/app", tty: false });
    const requestHead = [
      "POST /runLando HTTP/1.1",
      "Host: localhost",
      "Content-Type: application/json",
      "Content-Length: 999999999",
      ...headerLines,
      "",
      "",
    ].join("\r\n");
    socket.setEncoding("utf8");
    socket.setTimeout(1500, () => {
      socket.destroy();
      resolveOnce();
    });
    socket.on("connect", () => {
      socket.write(requestHead);
      socket.write("x".repeat(1024 * 1024 + 1));
      setTimeout(() => {
        if (!socket.destroyed) socket.write(payloadAfterLimit);
      }, 5);
      setTimeout(() => {
        if (!socket.destroyed) socket.write("more-bytes-after-limit");
      }, 10);
    });
    socket.on("data", (chunk) => {
      raw += chunk;
    });
    socket.on("error", (cause) => {
      if (raw.length > 0) resolveOnce();
      else reject(cause);
    });
    socket.on("close", resolveOnce);
  });

const authHeaders = (session: {
  readonly appId: string;
  readonly sessionId: string;
  readonly token: string;
}): Readonly<Record<string, string>> => ({
  authorization: `Bearer ${session.token}`,
  "x-lando-host-proxy-app": session.appId,
  "x-lando-host-proxy-session": session.sessionId,
  "x-lando-host-proxy-caller": "web",
  "x-lando-host-proxy-depth": "0",
});
