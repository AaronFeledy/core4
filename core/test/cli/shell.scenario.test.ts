import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Config } from "@oclif/core";
import { type Context, DateTime, Effect, Layer, Stream } from "effect";

import { shellApp } from "@lando/core/cli/operations";
import { ProviderUnavailableError, ShellExecError, ShellRequiresTtyError } from "@lando/core/errors";
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
  DeprecationService,
  LandofileService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  type ShellInteractiveSpec,
  ShellRunner,
} from "@lando/core/services";

import AppShellCommand from "../../src/cli/oclif/commands/app/shell.ts";
import { registerBuiltInContractDeprecations } from "../../src/deprecation/built-in-contracts.ts";
import { DeprecationServiceLive } from "../../src/deprecation/service.ts";

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

const fakeProvider = (overrides: Partial<RuntimeProviderShape> = {}): RuntimeProviderShape => {
  const base: RuntimeProviderShape = {
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
    runStream: () => Effect.die("not used") as never,
    logs: () => Effect.die("not used") as never,
    inspect: () => Effect.die("not used"),
    list: () => Effect.succeed([]),
    snapshotVolume: () => Effect.die("not used"),
    restoreVolume: () => Effect.die("not used"),
    listVolumes: () => Effect.succeed([]),
    removeVolume: () => Effect.void,
    copyToService: () => Effect.die("not used"),
    copyFromService: () => Effect.die("not used") as never,
    exportArtifact: () => Effect.die("not used") as never,
    importArtifact: () => Effect.die("not used"),
  };
  return Object.assign(base, overrides);
};

const shellRunnerLayer = (
  interactive: (spec: ShellInteractiveSpec) => Effect.Effect<{ readonly exitCode: number }, never> = () =>
    Effect.die("interactive not expected"),
  exec: Context.Tag.Service<typeof ShellRunner>["exec"] = () => Effect.die("exec not expected"),
) =>
  Layer.succeed(ShellRunner, {
    exec,
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
          ...(command.tty === undefined ? {} : { tty: command.tty }),
          ...(command.stdin === undefined ? {} : { stdin: command.stdin }),
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

    const error = await Effect.runPromise(
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
      }).pipe(Effect.provide(layer(undefined, provider)), Effect.flip),
    );
    expect(String(error)).toContain("boom");

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

  test("records --host deprecation use through the deprecation service", async () => {
    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        const deprecations = yield* DeprecationService;
        yield* registerBuiltInContractDeprecations(deprecations);
        yield* shellApp({
          host: true,
          isInteractive: () => true,
          shellPath: "/bin/sh",
        });
        return yield* deprecations.summary();
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layer(
              undefined,
              undefined,
              shellRunnerLayer(() => Effect.succeed({ exitCode: 0 })),
            ),
            DeprecationServiceLive,
          ),
        ),
      ),
    );

    expect(summary).toHaveLength(1);
    expect(summary[0]?.kind).toBe("flag");
    expect(summary[0]?.id).toBe("app:shell --host");
    expect(summary[0]?.count).toBe(1);
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
        calls.push({
          ...(command.signal === undefined ? {} : { signal: command.signal }),
          ...(command.terminalSize === undefined ? {} : { terminalSize: command.terminalSize }),
        });
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

  test("--no-interactive runs host shell through ShellRunner.exec", async () => {
    const calls: Array<{ command: string; cwd?: string; env?: Readonly<Record<string, string>> }> = [];
    const result = await Effect.runPromise(
      shellApp({
        isInteractive: () => false,
        noInteractive: true,
        shellPath: "/bin/sh",
        args: ["-lc", "exit 13"],
      }).pipe(
        Effect.provide(
          layer(
            undefined,
            undefined,
            shellRunnerLayer(undefined, (command, options) => {
              calls.push({
                command,
                ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
                ...(options?.env === undefined ? {} : { env: options.env }),
              });
              return Effect.fail(
                new ShellExecError({
                  message: "Shell command exited with code 13",
                  command,
                  exitCode: 13,
                  stdout: "",
                  stderr: "",
                }),
              );
            }),
          ),
        ),
      ),
    );
    expect(result.mode).toBe("host");
    expect(result.exitCode).toBe(13);
    expect(calls).toEqual([
      {
        command: "'/bin/sh' '-lc' 'exit 13'",
        cwd: "/tmp/shell-scenario",
        env: expect.objectContaining({ LANDO_APP_NAME: "shell-scenario" }),
      },
    ]);
  });

  test("a non-TTY stdin/stdout fails with ShellRequiresTtyError pointing at --no-interactive", async () => {
    const error = await Effect.runPromise(
      shellApp({ isInteractive: () => false }).pipe(Effect.provide(layer()), Effect.flip),
    );
    expect(error).toBeInstanceOf(ShellRequiresTtyError);
    const ttyError = error as ShellRequiresTtyError;
    expect(ttyError.remediation).toContain("lando shell --no-interactive");
    expect(ttyError.remediation).toContain("app:exec --interactive --tty -- <command>");
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

  test("is strict: bare positional service names are rejected, not silently ignored", () => {
    expect(AppShellCommand.strict).toBe(true);
  });
});

describe("lando shell — CLI argv parsing", () => {
  const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

  const withTempApp = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-shell-argv-")));
    try {
      await writeFile(join(dir, ".lando.yml"), "name: shell-argv\nruntime: 4\n");
      return await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  const runCli = async (
    args: ReadonlyArray<string>,
    cwd: string,
  ): Promise<{ readonly exitCode: number; readonly stderr: string }> => {
    const proc = Bun.spawn({
      cmd: [process.execPath, cliEntry, ...args],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    return { exitCode, stderr };
  };

  test("rejects a bare positional service name instead of silently opening a host shell", async () => {
    await withTempApp(async (dir) => {
      const result = await runCli(["app:shell", "web"], dir);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Unexpected argument: web");
    });
  }, 30_000);

  test("rejects a positional after the top-level shell alias", async () => {
    await withTempApp(async (dir) => {
      const result = await runCli(["shell", "web"], dir);
      expect(result.exitCode).toBe(2);
      // Source-mode topic resolution rejects `shell web` as an unknown id
      // before arg validation; either way the positional never silently
      // opens a host shell.
      expect(result.stderr).toContain("command shell:web not found");
    });
  }, 30_000);

  test("rejects --service followed by another flag instead of eating it as the value", async () => {
    await withTempApp(async (dir) => {
      const result = await runCli(["shell", "--service", "--no-history"], dir);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Flag --service expects a value");
    });
  }, 30_000);

  test("rejects a bare --service with no value", async () => {
    await withTempApp(async (dir) => {
      const result = await runCli(["shell", "--service"], dir);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Flag --service expects a value");
    });
  }, 30_000);
});
