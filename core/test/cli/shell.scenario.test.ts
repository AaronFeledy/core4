import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Config } from "@oclif/core";
import { DateTime, Effect, Layer, Stream } from "effect";

import { shellApp } from "@lando/core/cli/operations";
import { ProviderUnavailableError, ShellRequiresTtyError } from "@lando/core/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type LandofileShape,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/core/schema";
import {
  AppPlanner,
  LandofileService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  type ShellInteractiveSpec,
  ShellRunner,
} from "@lando/core/services";

import AppShellCommand from "../../src/cli/oclif/commands/app/shell.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const providerId = ProviderId.make("lando");

const capabilities: ProviderCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceHealth: "lando",
  hostReachability: "emulated",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  copyOnWriteAppRoot: false,
  volumeSnapshot: "none",
  serviceFileCopy: "none",
  artifactExport: false,
  artifactImport: false,
  ephemeralMounts: false,
  hostPortPublish: "proxy",
  routeProvider: false,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "portable",
  providerExtensions: [],
};

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-18T00:00:00Z"),
  source: "shell.scenario.test",
  runtime: 4 as const,
};

const servicePlan = (name: "web"): ServicePlan => ({
  name: ServiceName.make(name),
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "server.js"],
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const web = servicePlan("web");

const plan: AppPlan = {
  id: AppId.make("shell-scenario"),
  name: "shell-scenario",
  slug: "shell-scenario",
  root: AbsolutePath.make("/tmp/shell-scenario"),
  provider: providerId,
  services: { [web.name]: web },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const fakeProvider = (overrides: Partial<RuntimeProviderShape> = {}): RuntimeProviderShape => ({
  id: providerId,
  displayName: "Fake",
  version: "0.0.0",
  platform: "linux",
  capabilities,
  isAvailable: Effect.succeed(true),
  setup: () => Effect.void,
  getStatus: Effect.succeed({ running: true }),
  getVersions: Effect.succeed({ provider: "0.0.0" }),
  buildArtifact: () => Effect.die("not used"),
  pullArtifact: () => Effect.die("not used"),
  removeArtifact: () => Effect.void,
  apply: () => Effect.succeed({ changed: false }),
  start: () => Effect.void,
  stop: () => Effect.void,
  restart: () => Effect.void,
  destroy: () => Effect.void,
  exec: () => Effect.die("not used"),
  execStream: () => Effect.die("not used") as never,
  run: () => Effect.die("not used"),
  logs: () => Effect.die("not used") as never,
  inspect: () => Effect.die("not used"),
  list: () => Effect.succeed([]),
  ...overrides,
});

const shellRunnerLayer = (
  interactive: (spec: ShellInteractiveSpec) => Effect.Effect<{ readonly exitCode: number }, never> = () =>
    Effect.die("interactive not expected"),
) =>
  Layer.succeed(ShellRunner, {
    exec: () => Effect.die("not used"),
    run: () => Effect.die("not used"),
    runScript: () => Effect.die("not used"),
    interactive,
  });

const layer = (
  landofile: LandofileShape = { name: "shell-scenario" },
  provider: RuntimeProviderShape = fakeProvider(),
  shellRunner = shellRunnerLayer(),
) =>
  Layer.mergeAll(
    Layer.succeed(LandofileService, { discover: Effect.succeed(landofile) }),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(capabilities),
      select: () => Effect.succeed(provider),
    }),
    shellRunner,
  );

describe("shellApp — shell modes", () => {
  test("service mode defaults to provider execStream for a requested service", async () => {
    const calls: Array<{ service: string; command: ReadonlyArray<string>; tty?: boolean; stdin?: string }> =
      [];
    let stdout = "";
    const provider = fakeProvider({
      execStream: (target, command) => {
        calls.push({
          service: String(target.service),
          command: command.command,
          tty: command.tty,
          stdin: command.stdin,
        });
        return Stream.make(
          { kind: "stdout" as const, chunk: new TextEncoder().encode("inside\n") },
          { exitCode: 0 },
        );
      },
    });

    const result = await Effect.runPromise(
      shellApp({
        service: "web",
        io: {
          writeStdout: (chunk) => {
            stdout += chunk;
          },
          writeStderr: () => {},
        },
      }).pipe(Effect.provide(layer(undefined, provider))),
    );

    expect(result.mode).toBe("service");
    expect(result.service).toBe("web");
    expect(result.exitCode).toBe(0);
    expect(stdout).toBe("inside\n");
    expect(calls).toEqual([{ service: "web", command: ["sh", "-l"], tty: true, stdin: "inherit" }]);
  });

  test("service mode preserves UTF-8 characters split across exec chunks", async () => {
    let stdout = "";
    const provider = fakeProvider({
      execStream: () =>
        Stream.make(
          { kind: "stdout" as const, chunk: new Uint8Array([0x61, 0xe2]) },
          { kind: "stdout" as const, chunk: new Uint8Array([0x82, 0xac, 0x62]) },
          { exitCode: 0 },
        ),
    });

    await Effect.runPromise(
      shellApp({
        service: "web",
        io: {
          writeStdout: (chunk) => {
            stdout += chunk;
          },
          writeStderr: () => {},
        },
      }).pipe(Effect.provide(layer(undefined, provider))),
    );

    expect(stdout).toBe("a€b");
  });

  test("service mode enables raw stdin for interactive TTY and restores it on exit", async () => {
    let raw = false;
    let paused = true;
    const rawModes: boolean[] = [];
    const provider = fakeProvider({
      execStream: () =>
        Stream.fromEffect(
          Effect.sync(() => {
            expect(raw).toBe(true);
            expect(paused).toBe(false);
            return { exitCode: 0 };
          }),
        ),
    });

    await Effect.runPromise(
      shellApp({
        service: "web",
        io: {
          writeStdout: () => {},
          writeStderr: () => {},
          stdin: (async function* () {})(),
          stdinIsTTY: () => true,
          stdinIsRaw: () => raw,
          stdinIsPaused: () => paused,
          setStdinRawMode: (nextRaw) => {
            rawModes.push(nextRaw);
            raw = nextRaw;
          },
          resumeStdin: () => {
            paused = false;
          },
          pauseStdin: () => {
            paused = true;
          },
        },
      }).pipe(Effect.provide(layer(undefined, provider))),
    );

    expect(raw).toBe(false);
    expect(paused).toBe(true);
    expect(rawModes).toEqual([true, false]);
  });

  test("service mode restores raw stdin when provider exec fails", async () => {
    let raw = false;
    const provider = fakeProvider({
      execStream: () =>
        Stream.fail(
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "execStream",
            message: "boom",
          }),
        ),
    });

    await expect(
      Effect.runPromise(
        shellApp({
          service: "web",
          io: {
            writeStdout: () => {},
            writeStderr: () => {},
            stdin: (async function* () {})(),
            stdinIsTTY: () => true,
            stdinIsRaw: () => raw,
            setStdinRawMode: (nextRaw) => {
              raw = nextRaw;
            },
          },
        }).pipe(Effect.provide(layer(undefined, provider))),
      ),
    ).rejects.toThrow("boom");

    expect(raw).toBe(false);
  });

  test("defaults to host mode (no --service) and routes through ShellRunner.interactive", async () => {
    const specs: ShellInteractiveSpec[] = [];
    const result = await Effect.runPromise(
      shellApp({
        isInteractive: () => true,
        shellPath: "/bin/bash",
      }).pipe(
        Effect.provide(
          layer(
            undefined,
            undefined,
            shellRunnerLayer((spec) => {
              specs.push(spec);
              return Effect.succeed({ exitCode: 0 });
            }),
          ),
        ),
      ),
    );

    expect(result.mode).toBe("host");
    expect(result.app).toBe("shell-scenario");
    expect(specs).toHaveLength(1);
    expect(specs[0]?.shell).toBe("/bin/bash");
    expect(specs[0]?.cwd).toBe("/tmp/shell-scenario");
    expect(specs[0]?.env?.LANDO_APP_NAME).toBe("shell-scenario");
    expect(specs[0]?.historyFile).toMatch(/[/\\]shell[/\\].+[/\\]history$/);
  });

  test("--service <name> explicitly selects service mode", async () => {
    const calls: Array<{ service: string }> = [];
    const provider = fakeProvider({
      execStream: (target) => {
        calls.push({ service: String(target.service) });
        return Stream.make({ exitCode: 0 });
      },
    });

    const result = await Effect.runPromise(
      shellApp({
        service: "web",
        io: { writeStdout: () => {}, writeStderr: () => {} },
      }).pipe(Effect.provide(layer(undefined, provider))),
    );

    expect(result.mode).toBe("service");
    expect(result.service).toBe("web");
    expect(calls).toEqual([{ service: "web" }]);
  });

  test("service mode forwards AbortSignal and terminal dimensions to provider exec", async () => {
    const controller = new AbortController();
    controller.abort();
    const calls: Array<{ signal?: AbortSignal; terminalSize?: { columns: number; rows: number } }> = [];
    const provider = fakeProvider({
      execStream: (_target, command) => {
        calls.push({ signal: command.signal, terminalSize: command.terminalSize });
        return Stream.make({ exitCode: 0 });
      },
    });

    await Effect.runPromise(
      shellApp({
        service: "web",
        signal: controller.signal,
        io: {
          writeStdout: () => {},
          writeStderr: () => {},
          terminalSize: () => ({ columns: 132, rows: 43 }),
        },
      }).pipe(Effect.provide(layer(undefined, provider))),
    );

    expect(calls[0]?.signal).toBe(controller.signal);
    expect(calls[0]?.terminalSize).toEqual({ columns: 132, rows: 43 });
  });

  test("service mode forwards terminal resize events after exec starts", async () => {
    let resizeListener: (() => void) | undefined;
    const observedResizeEvents: Array<{ columns: number; rows: number }> = [];
    const provider = fakeProvider({
      execStream: (_target, command) =>
        (command.terminalResize ?? Stream.empty).pipe(
          Stream.take(1),
          Stream.map((size) => {
            observedResizeEvents.push(size);
            return { exitCode: 0 };
          }),
        ),
    });

    await Effect.runPromise(
      shellApp({
        service: "web",
        io: {
          writeStdout: () => {},
          writeStderr: () => {},
          terminalSize: () => ({ columns: 101, rows: 33 }),
          onResize: (listener) => {
            resizeListener = listener;
            queueMicrotask(listener);
            return () => {
              resizeListener = undefined;
            };
          },
        },
      }).pipe(Effect.provide(layer(undefined, provider))),
    );

    expect(observedResizeEvents).toEqual([{ columns: 101, rows: 33 }]);
    expect(resizeListener).toBeUndefined();
  });

  const hostSpec = (options: Parameters<typeof shellApp>[0] = {}): Promise<ShellInteractiveSpec> =>
    Effect.runPromise(
      Effect.gen(function* () {
        let captured: ShellInteractiveSpec | undefined;
        yield* shellApp({ isInteractive: () => true, shellPath: "/bin/sh", ...options }).pipe(
          Effect.provide(
            layer(
              undefined,
              undefined,
              shellRunnerLayer((spec) => {
                captured = spec;
                return Effect.succeed({ exitCode: 0 });
              }),
            ),
          ),
        );
        if (captured === undefined) throw new Error("interactive was not called");
        return captured;
      }),
    );

  test("host mode resolves cwd to the app root and propagates the exit code", async () => {
    const specs: ShellInteractiveSpec[] = [];
    const result = await Effect.runPromise(
      shellApp({ isInteractive: () => true, shellPath: "/bin/sh" }).pipe(
        Effect.provide(
          layer(
            undefined,
            undefined,
            shellRunnerLayer((spec) => {
              specs.push(spec);
              return Effect.succeed({ exitCode: 7 });
            }),
          ),
        ),
      ),
    );
    expect(result.mode).toBe("host");
    expect(result.exitCode).toBe(7);
    expect(specs[0]?.cwd).toBe("/tmp/shell-scenario");
    expect(specs[0]?.shell).toBe("/bin/sh");
    expect(specs[0]?.env?.LANDO_APP_NAME).toBe("shell-scenario");
    expect(specs[0]?.env?.LANDO_APP_ROOT).toBe("/tmp/shell-scenario");
  });

  test("custom cwd overrides the planned app root", async () => {
    const spec = await hostSpec({ cwd: "/tmp/other" });
    expect(spec.cwd).toBe("/tmp/other");
  });

  test("reserved LANDO_* env wins over caller options.env", async () => {
    const spec = await hostSpec({
      env: { LANDO_APP_NAME: "spoofed", LANDO_APP_ROOT: "/etc/spoof", MY_CUSTOM: "kept" },
    });
    expect(spec.env?.LANDO_APP_NAME).toBe("shell-scenario");
    expect(spec.env?.LANDO_APP_ROOT).toBe("/tmp/shell-scenario");
    expect(spec.env?.MY_CUSTOM).toBe("kept");
  });

  test("default host mode persists history under a per-app HISTFILE path", async () => {
    const spec = await hostSpec();
    expect(spec.historyFile).toMatch(/[/\\]shell[/\\].+[/\\]history$/);
    expect(spec.env?.HISTFILE).toBeUndefined();
  });

  test("--no-history disables host shell history for the session", async () => {
    const spec = await hostSpec({ noHistory: true });
    expect(spec.historyFile).toBeUndefined();
    expect(spec.env?.HISTFILE).toBe("/dev/null");
    expect(spec.env?.HISTSIZE).toBe("0");
    expect(spec.env?.HISTFILESIZE).toBe("0");
  });

  test("--no-interactive fails fast with ShellRequiresTtyError and remediation", async () => {
    const error = await Effect.runPromise(
      shellApp({ isInteractive: () => true, noInteractive: true }).pipe(Effect.provide(layer()), Effect.flip),
    );
    expect(error).toBeInstanceOf(ShellRequiresTtyError);
    expect((error as ShellRequiresTtyError).remediation).toContain("app:exec --interactive --tty");
  });

  test("a non-TTY stdin/stdout fails with ShellRequiresTtyError", async () => {
    const error = await Effect.runPromise(
      shellApp({ isInteractive: () => false }).pipe(Effect.provide(layer()), Effect.flip),
    );
    expect(error).toBeInstanceOf(ShellRequiresTtyError);
  });
});

describe("lando shell — CLI surface", () => {
  test("registers `shell` and `app:shell` as a top-level alias and OCLIF id", async () => {
    const config = await Config.load({ root: resolve(repoRoot, "core"), ignoreManifest: true });
    const rootPlugin = config.plugins.get(config.pjson.name);
    if (rootPlugin === undefined) throw new Error("OCLIF root plugin missing");
    const aliasesById = new Map(
      rootPlugin.commands.map((command) => [command.id, command.aliases ?? []] as const),
    );
    expect(aliasesById.get("app:shell")).toContain("shell");
    expect(AppShellCommand.aliases).toContain("shell");
  });

  test("declares service, host, no-history, and no-interactive flags", () => {
    const flags = Object.keys(AppShellCommand.flags);
    expect(flags).toContain("service");
    expect(flags).toContain("host");
    expect(flags).toContain("no-history");
    expect(flags).toContain("no-interactive");
  });
});
