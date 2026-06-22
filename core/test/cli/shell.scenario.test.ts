import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Config } from "@oclif/core";
import { DateTime, Effect, Layer, Stream } from "effect";

import { shellApp } from "@lando/core/cli/operations";
import { ProviderUnavailableError } from "@lando/core/errors";
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

const layer = (
  landofile: LandofileShape = { name: "shell-scenario" },
  provider: RuntimeProviderShape = fakeProvider(),
) =>
  Layer.mergeAll(
    Layer.succeed(LandofileService, { discover: Effect.succeed(landofile) }),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(capabilities),
      select: () => Effect.succeed(provider),
    }),
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

  test("service mode uses the primary service when no service is requested", async () => {
    const calls: Array<{ service: string; command: ReadonlyArray<string>; tty?: boolean; stdin?: string }> =
      [];
    const provider = fakeProvider({
      execStream: (target, command) => {
        calls.push({
          service: String(target.service),
          command: command.command,
          tty: command.tty,
          stdin: command.stdin,
        });
        return Stream.make({ exitCode: 0 });
      },
    });

    const result = await Effect.runPromise(
      shellApp({
        io: {
          writeStdout: () => {},
          writeStderr: () => {},
        },
      }).pipe(Effect.provide(layer(undefined, provider))),
    );

    expect(result.mode).toBe("service");
    expect(result.service).toBe("web");
    expect(calls).toEqual([{ service: "web", command: ["sh", "-l"], tty: true, stdin: "inherit" }]);
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

  test("host mode resolves cwd to the planned app root and propagates exit code from the launcher", async () => {
    const captures: Array<{ shell: string; cwd: string; env: Record<string, string> }> = [];
    const result = await Effect.runPromise(
      shellApp({
        host: true,
        shellPath: "/bin/sh",
        args: ["-c", "exit 7"],
        launch: async (spec) => {
          captures.push({
            shell: spec.shell,
            cwd: spec.cwd,
            env: { ...spec.env } as Record<string, string>,
          });
          return { exitCode: 7 };
        },
      }).pipe(Effect.provide(layer())),
    );
    expect(result.mode).toBe("host");
    expect(result.exitCode).toBe(7);
    expect(result.app).toBe("shell-scenario");
    expect(captures).toHaveLength(1);
    expect(captures[0]?.cwd).toBe("/tmp/shell-scenario");
    expect(captures[0]?.shell).toBe("/bin/sh");
    expect(captures[0]?.env.LANDO_APP_NAME).toBe("shell-scenario");
    expect(captures[0]?.env.LANDO_APP_ROOT).toBe("/tmp/shell-scenario");
  });

  test("custom cwd overrides the planned app root", async () => {
    let observedCwd = "";
    await Effect.runPromise(
      shellApp({
        host: true,
        shellPath: "/bin/sh",
        cwd: "/tmp/other",
        args: ["-c", "exit 0"],
        launch: async (spec) => {
          observedCwd = spec.cwd;
          return { exitCode: 0 };
        },
      }).pipe(Effect.provide(layer())),
    );
    expect(observedCwd).toBe("/tmp/other");
  });

  test("reserved LANDO_* env wins over caller options.env", async () => {
    let observedEnv: Record<string, string> = {};
    await Effect.runPromise(
      shellApp({
        host: true,
        shellPath: "/bin/sh",
        args: ["-c", "exit 0"],
        env: {
          LANDO_APP_NAME: "spoofed",
          LANDO_APP_ROOT: "/etc/spoof",
          MY_CUSTOM: "kept",
        },
        launch: async (spec) => {
          observedEnv = { ...spec.env };
          return { exitCode: 0 };
        },
      }).pipe(Effect.provide(layer())),
    );
    expect(observedEnv.LANDO_APP_NAME).toBe("shell-scenario");
    expect(observedEnv.LANDO_APP_ROOT).toBe("/tmp/shell-scenario");
    expect(observedEnv.MY_CUSTOM).toBe("kept");
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

  test("declares --host for host mode", () => {
    expect(Object.keys(AppShellCommand.flags)).toContain("host");
  });
});
