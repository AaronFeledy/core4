import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AppPlan,
  LandofileShape,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
  StreamFrame,
} from "@lando/core/schema";
import {
  type ConfigService,
  type EventService,
  PathsService,
  RuntimeProvider,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  type ScratchAcquireInput,
  ScratchAppService,
} from "@lando/core/services";
import { Effect, Exit, Fiber, Layer, Schema, Stream } from "effect";

import { CacheServiceLive } from "../../src/cache/service.ts";
import {
  type ScratchRunResult,
  defaultScratchRunDeps,
  normalizeScratchRunArgvForParsing,
  parseScratchRunArgv,
  renderScratchRunResult,
  scratchRun,
  scratchRunHasCommandTail,
  scratchRunOptionsFromInput,
  scratchRunSuccessExitCode,
} from "../../src/cli/commands/scratch-run.ts";
import { scratchList } from "../../src/cli/commands/scratch.ts";
import { resolveResultFormat } from "../../src/cli/format-flags.ts";
import { appsScratchRunSpec } from "../../src/cli/oclif/commands/apps/scratch/run.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
import { makeJsonRendererServiceLive } from "../../src/cli/renderer/runtime.ts";
import { makeLandoPaths } from "../../src/config/paths.ts";
import { DataMoverLive } from "../../src/data-mover/service.ts";
import { GlobalAppServiceLive } from "../../src/global-app/service.ts";
import { LandofileServiceLive } from "../../src/landofile/service.ts";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { type RedactionService, RedactionServiceLive } from "../../src/redaction/service.ts";
import { ScratchRegistryLive, makeScratchRegistry } from "../../src/scratch-app/registry.ts";
import { ScratchResourceScannerLive } from "../../src/scratch-app/scanner.ts";
import { ScratchAppServiceLive, readScratchLandofile } from "../../src/scratch-app/service.ts";
import { AppPlanResolverLive } from "../../src/services/app-plan-resolver.ts";
import { BuildOrchestratorLive } from "../../src/services/build-orchestrator.ts";
import { ConfigServiceLive } from "../../src/services/config.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";
import { SecretStoreLive } from "../../src/services/secret-store.ts";
import { StateStoreLive } from "../../src/state/service.ts";
import { agentEnvConfigServiceLayer } from "./agent-env-test-config.ts";

const providerId = ProviderId.make("lando");

const capabilities: ProviderCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceLogSources: true,
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

interface ExecCall {
  readonly app: string;
  readonly service: string;
  readonly command: ReadonlyArray<string>;
  readonly tty: boolean | undefined;
  readonly stdin: string | undefined;
  readonly env: Readonly<Record<string, string>> | undefined;
}

interface DestroyCall {
  readonly app: string;
  readonly volumes: boolean;
}

interface Recorded {
  readonly appliedPlans: AppPlan[];
  readonly destroyCalls: DestroyCall[];
  readonly execCalls: ExecCall[];
}

interface HarnessOptions {
  readonly buildCalls?: string[];
  readonly artifactBuild?: boolean;
  readonly execExitCode?: number;
  readonly execStdout?: string;
  readonly execStderr?: string;
  readonly execNever?: boolean;
  readonly configLayer?: Layer.Layer<ConfigService>;
}

const die = (operation: string) =>
  Effect.dieMessage(`scratch run test provider should not call ${operation}`);

const makeHarnessLayer = (recorded: Recorded, options: HarnessOptions = {}) => {
  const provider: RuntimeProviderShape = {
    id: String(providerId),
    displayName: "Scratch Run Test Provider",
    version: "0.0.0",
    platform: "linux",
    capabilities: { ...capabilities, artifactBuild: options.artifactBuild ?? capabilities.artifactBuild },
    isAvailable: Effect.succeed(true),
    setup: () => Effect.void,
    getStatus: Effect.succeed({ running: true, message: "ready" }),
    getVersions: Effect.succeed({ provider: "0.0.0" }),
    buildArtifact: (spec) =>
      Effect.sync(() => {
        options.buildCalls?.push(String(spec.service));
        return { providerId, ref: `${spec.service}:built` };
      }),
    pullArtifact: (spec) =>
      Effect.sync(() => {
        options.buildCalls?.push(spec.ref);
        return { providerId, ref: spec.ref };
      }),
    removeArtifact: () => Effect.void,
    apply: (plan) =>
      Effect.sync(() => {
        recorded.appliedPlans.push(plan);
        return { changed: true };
      }),
    start: () => die("start"),
    stop: () => die("stop"),
    restart: () => die("restart"),
    destroy: (target, destroyOptions) =>
      Effect.sync(() => {
        recorded.destroyCalls.push({ app: String(target.app), volumes: destroyOptions.volumes });
      }),
    exec: (target, spec) => {
      const record = Effect.sync(() => {
        recorded.execCalls.push({
          app: String(target.app),
          service: String(target.service),
          command: spec.command,
          tty: spec.tty,
          stdin: spec.stdin,
          env: spec.env,
        });
      });
      if (options.execNever === true) return record.pipe(Effect.zipRight(Effect.never));
      return record.pipe(
        Effect.as({
          exitCode: options.execExitCode ?? 0,
          stdout: options.execStdout ?? "",
          stderr: options.execStderr ?? "",
        }),
      );
    },
    execStream: () => Stream.die("scratch run test provider should not call execStream"),
    run: () => die("run"),
    runStream: () => Stream.die("scratch run test provider should not call runStream"),
    logs: () => Stream.empty,
    inspect: () => die("inspect"),
    list: () => Effect.succeed([]),
    snapshotVolume: () => die("snapshotVolume"),
    restoreVolume: () => die("restoreVolume"),
    listVolumes: () => Effect.succeed([]),
    removeVolume: () => die("removeVolume"),
    copyToService: () => die("copyToService"),
    copyFromService: () => Stream.die("scratch run test provider should not call copyFromService"),
    exportArtifact: () => Stream.die("scratch run test provider should not call exportArtifact"),
    importArtifact: () => die("importArtifact"),
  };

  const plannerLive = AppPlannerLive.pipe(
    Layer.provide(Layer.mergeAll(PluginRegistryLive, CacheServiceLive, ConfigServiceLive)),
  );
  const configLive = options.configLayer ?? ConfigServiceLive;
  const globalAppLive = GlobalAppServiceLive.pipe(Layer.provide(Layer.mergeAll(configLive, FileSystemLive)));
  const resolverLive = AppPlanResolverLive.pipe(
    Layer.provide(Layer.mergeAll(FileSystemLive, globalAppLive, plannerLive)),
  );
  const redactionLive = RedactionServiceLive.pipe(Layer.provide(SecretStoreLive));
  const eventLive = EventServiceLive.pipe(Layer.provide(redactionLive));
  const pathsLive = Layer.succeed(PathsService, makeLandoPaths());
  const registryLive = Layer.succeed(RuntimeProviderRegistry, {
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(provider),
  });
  const scratchDeps = Layer.mergeAll(
    FileSystemLive,
    LandofileServiceLive,
    resolverLive,
    registryLive,
    eventLive,
    pathsLive,
    redactionLive,
    ScratchRegistryLive,
    ScratchResourceScannerLive,
    DataMoverLive.pipe(
      Layer.provide(Layer.mergeAll(StateStoreLive, pathsLive, Layer.succeed(RuntimeProvider, provider))),
    ),
  );
  const buildOrchestratorLive = BuildOrchestratorLive.pipe(
    Layer.provide(Layer.mergeAll(eventLive, pathsLive, registryLive, StateStoreLive)),
  );
  return Layer.mergeAll(
    scratchDeps,
    plannerLive,
    globalAppLive,
    buildOrchestratorLive,
    ScratchAppServiceLive.pipe(Layer.provide(Layer.mergeAll(scratchDeps, buildOrchestratorLive))),
    configLive,
  );
};

const testSupportLayer = (): Layer.Layer<EventService | RedactionService> => {
  const redactionLive = RedactionServiceLive.pipe(Layer.provide(SecretStoreLive));
  return Layer.mergeAll(redactionLive, EventServiceLive.pipe(Layer.provide(redactionLive)));
};

const withTempProject = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-run-app-")));
  const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-run-cache-")));
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-run-data-")));
  const confRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-run-conf-")));
  const previousCwd = process.cwd();
  const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
  const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
  const previousConfRoot = process.env.LANDO_USER_CONF_ROOT;
  try {
    process.chdir(dir);
    process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
    process.env.LANDO_USER_DATA_ROOT = dataRoot;
    process.env.LANDO_USER_CONF_ROOT = confRoot;
    return await run(dir);
  } finally {
    process.chdir(previousCwd);
    // biome-ignore lint/performance/noDelete: env delete avoids Bun coercing undefined to "undefined".
    if (previousCacheRoot === undefined) delete process.env.LANDO_USER_CACHE_ROOT;
    else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
    // biome-ignore lint/performance/noDelete: env delete avoids Bun coercing undefined to "undefined".
    if (previousDataRoot === undefined) delete process.env.LANDO_USER_DATA_ROOT;
    else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
    // biome-ignore lint/performance/noDelete: env delete avoids Bun coercing undefined to "undefined".
    if (previousConfRoot === undefined) delete process.env.LANDO_USER_CONF_ROOT;
    else process.env.LANDO_USER_CONF_ROOT = previousConfRoot;
    await rm(dir, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
    await rm(confRoot, { recursive: true, force: true });
  }
};

describe("parseScratchRunArgv", () => {
  test("everything after -- passes verbatim as the command", () => {
    const options = parseScratchRunArgv(["--", "echo", "ok", "--keep"]);
    expect(options.command).toEqual(["echo", "ok", "--keep"]);
    expect(options.keep).toBe(false);
    expect(options.mount).toBe(true);
    expect(options.from).toBeUndefined();
    expect(options.issues).toEqual([]);
  });

  test("parses lando flags before the command tail", () => {
    const options = parseScratchRunArgv([
      "--from",
      "lamp",
      "--service",
      "database",
      "--no-mount",
      "--answer",
      "php=8.3",
      "--answer",
      "via=cli",
      "--keep",
      "--",
      "tool",
      "--flag",
    ]);
    expect(options.from).toBe("lamp");
    expect(options.service).toBe("database");
    expect(options.mount).toBe(false);
    expect(options.keep).toBe(true);
    expect(options.answers).toEqual({ php: "8.3", via: "cli" });
    expect(options.command).toEqual(["tool", "--flag"]);
  });

  test("the first bare token starts the command without --", () => {
    const options = parseScratchRunArgv(["composer", "install", "--no-dev"]);
    expect(options.command).toEqual(["composer", "install", "--no-dev"]);
    expect(options.mount).toBe(true);
  });

  test("known lando flags after the first command token stay in the command", () => {
    const options = parseScratchRunArgv(["echo", "--keep"]);
    expect(options.command).toEqual(["echo", "--keep"]);
    expect(options.keep).toBe(false);
  });

  test("a value flag with no value is an issue", () => {
    const options = parseScratchRunArgv(["--from"]);
    expect(options.issues.length).toBeGreaterThan(0);
  });

  test("scratchRunOptionsFromInput reads raw argv and the abort signal", () => {
    const controller = new AbortController();
    const options = scratchRunOptionsFromInput({
      argv: ["--keep", "--", "true"],
      flags: {},
      args: {},
      signal: controller.signal,
    });
    expect(options.keep).toBe(true);
    expect(options.command).toEqual(["true"]);
    expect(options.signal).toBe(controller.signal);
  });

  test("scratchRunOptionsFromInput merges OCLIF structured flags with the command argv", () => {
    const options = scratchRunOptionsFromInput({
      argv: ["node", "--version"],
      flags: {
        from: "lamp",
        service: "appserver",
        "no-mount": true,
        answer: ["php=8.3", "webroot=public"],
        keep: true,
      },
      args: {},
    });
    expect(options.command).toEqual(["node", "--version"]);
    expect(options.from).toBe("lamp");
    expect(options.service).toBe("appserver");
    expect(options.mount).toBe(false);
    expect(options.keep).toBe(true);
    expect(options.answers).toEqual({ php: "8.3", webroot: "public" });
  });

  test("normalizes bare command tails before OCLIF can parse tool flags", () => {
    expect(normalizeScratchRunArgvForParsing(["node", "--version"])).toEqual(["--", "node", "--version"]);
    expect(normalizeScratchRunArgvForParsing(["--from", "toolbox", "node", "--version"])).toEqual([
      "--from",
      "toolbox",
      "--",
      "node",
      "--version",
    ]);
    expect(normalizeScratchRunArgvForParsing(["--keep", "--", "echo", "ok"])).toEqual([
      "--keep",
      "--",
      "echo",
      "ok",
    ]);
    expect(normalizeScratchRunArgvForParsing(["-v", "node", "--version"])).toEqual([
      "--",
      "-v",
      "node",
      "--version",
    ]);
    expect(normalizeScratchRunArgvForParsing(["--version", "node"])).toEqual(["--", "--version", "node"]);
    expect(scratchRunHasCommandTail(["node", "--help"])).toBe(true);
    expect(scratchRunHasCommandTail(["--help"])).toBe(false);
    expect(scratchRunHasCommandTail(["--version"])).toBe(false);
    expect(scratchRunHasCommandTail(["-v"])).toBe(false);
  });

  test("normalization protects tool output flags from universal result-format parsing", () => {
    expect(
      resolveResultFormat({ argv: normalizeScratchRunArgvForParsing(["node", "--format=json"]) }),
    ).toEqual({
      format: "text",
      remainingArgv: ["--", "node", "--format=json"],
      source: "default",
    });
    expect(resolveResultFormat({ argv: normalizeScratchRunArgvForParsing(["node", "--json"]) })).toEqual({
      format: "text",
      remainingArgv: ["--", "node", "--json"],
      source: "default",
    });
    expect(resolveResultFormat({ argv: normalizeScratchRunArgvForParsing(["node", "-j"]) })).toEqual({
      format: "text",
      remainingArgv: ["--", "node", "-j"],
      source: "default",
    });
    expect(
      resolveResultFormat({ argv: normalizeScratchRunArgvForParsing(["--format", "json", "node"]) }),
    ).toEqual({
      format: "json",
      remainingArgv: ["node"],
      source: "format",
    });
  });
});

describe("scratchRun", () => {
  test("runs the command in the toolbox scratch and destroys it on scope close", async () => {
    await withTempProject(async (dir) => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const result = await Effect.runPromise(
        scratchRun({
          command: ["echo", "ok"],
          mount: true,
          keep: false,
          answers: {},
          issues: [],
        }).pipe(
          Effect.provide(makeHarnessLayer(recorded, { execStdout: "ok\n" })),
          Effect.provide(testSupportLayer()),
        ),
      );

      expect(recorded.appliedPlans).toHaveLength(1);
      const plan = recorded.appliedPlans[0];
      if (plan === undefined) throw new Error("scratch run did not apply a plan");
      expect(Object.keys(plan.services)).toEqual(["toolbox"]);

      expect(recorded.execCalls).toHaveLength(1);
      expect(recorded.execCalls[0]?.service).toBe("toolbox");
      expect(recorded.execCalls[0]?.command).toEqual(["echo", "ok"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("ok\n");
      expect(result.kept).toBe(false);
      expect(result.service).toBe("toolbox");
      expect(result.scratchId.startsWith("scratch-toolbox-")).toBe(true);

      expect(recorded.destroyCalls).toHaveLength(1);
      expect(recorded.destroyCalls[0]?.app).toBe(String(plan.id));

      const toolboxService = plan.services[Object.keys(plan.services)[0] as keyof typeof plan.services];
      const mountsCwd =
        toolboxService?.appMount?.source === dir ||
        toolboxService?.mounts.some((mount) => mount.type === "bind" && mount.source === dir) === true;
      expect(mountsCwd).toBe(true);

      const appMountTarget = toolboxService?.appMount?.target;
      const duplicateAppMountBinds = (toolboxService?.mounts ?? []).filter(
        (mount) => mount.target === appMountTarget && mount.source !== toolboxService?.appMount?.source,
      );
      expect(duplicateAppMountBinds).toEqual([]);
    });
  });

  test("--no-mount plans the scratch without a cwd bind mount", async () => {
    await withTempProject(async (dir) => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      await Effect.runPromise(
        scratchRun({
          command: ["true"],
          mount: false,
          keep: false,
          answers: {},
          issues: [],
        }).pipe(Effect.provide(makeHarnessLayer(recorded)), Effect.provide(testSupportLayer())),
      );
      const plan = recorded.appliedPlans[0];
      if (plan === undefined) throw new Error("scratch run did not apply a plan");
      const service = plan.services[Object.keys(plan.services)[0] as keyof typeof plan.services];
      expect(service?.appMount?.source === dir).toBe(false);
      expect(service?.mounts.some((mount) => mount.type === "bind" && mount.source === dir)).toBe(false);
    });
  });

  test("applies the artifact refs returned by the scratch build orchestrator", async () => {
    await withTempProject(async (dir) => {
      await writeFile(join(dir, "Dockerfile"), "FROM alpine\n");
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: scratch-build",
          "services:",
          "  web:",
          "    type: compose",
          "    primary: true",
          "    composeBuild:",
          "      context: .",
          "      dockerfile: Dockerfile",
          "",
        ].join("\n"),
      );
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const buildCalls: string[] = [];

      await Effect.runPromise(
        Effect.scoped(
          Effect.flatMap(ScratchAppService, (scratch) =>
            scratch.acquire({ source: { kind: "fork" }, detached: false, isolate: "cwd" }),
          ),
        ).pipe(
          Effect.provide(makeHarnessLayer(recorded, { artifactBuild: true, buildCalls })),
          Effect.provide(testSupportLayer()),
        ),
      );

      expect(buildCalls).toEqual(["web"]);
      expect(recorded.appliedPlans[0]?.services[ServiceName.make("web")]?.artifact).toEqual({
        kind: "ref",
        ref: "web:built",
      });
    });
  });

  test("a non-zero tool exit code is a successful result, not a tagged error", async () => {
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const result = await Effect.runPromise(
        scratchRun({
          command: ["sh", "-c", "exit 7"],
          mount: true,
          keep: false,
          answers: {},
          issues: [],
        }).pipe(
          Effect.provide(makeHarnessLayer(recorded, { execExitCode: 7 })),
          Effect.provide(testSupportLayer()),
        ),
      );
      expect(result.exitCode).toBe(7);
      expect(recorded.destroyCalls).toHaveLength(1);
      expect(scratchRunSuccessExitCode(result)).toBe(7);
    });
  });

  test("an unknown --service fails with ScratchRunTargetError and still tears down", async () => {
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const exit = await Effect.runPromiseExit(
        scratchRun({
          command: ["true"],
          service: "nope",
          mount: true,
          keep: false,
          answers: {},
          issues: [],
        }).pipe(Effect.provide(makeHarnessLayer(recorded)), Effect.provide(testSupportLayer())),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Exit.causeOption(exit);
        const rendered = JSON.stringify(failure);
        expect(rendered).toContain("ScratchRunTargetError");
        expect(rendered).toContain("toolbox");
      }
      expect(recorded.execCalls).toHaveLength(0);
      expect(recorded.destroyCalls).toHaveLength(1);
    });
  });

  test("--keep does not detach when target resolution fails", async () => {
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const layer = makeHarnessLayer(recorded);
      const exit = await Effect.runPromiseExit(
        scratchRun({
          command: ["true"],
          service: "nope",
          mount: true,
          keep: true,
          answers: {},
          issues: [],
        }).pipe(Effect.provide(layer), Effect.provide(testSupportLayer())),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(recorded.execCalls).toHaveLength(0);
      expect(recorded.destroyCalls).toHaveLength(1);

      const summaries = await Effect.runPromise(
        scratchList().pipe(Effect.provide(layer), Effect.provide(testSupportLayer())),
      );
      expect(summaries).toEqual([]);
    });
  });

  test("an empty command fails before any scratch is acquired", async () => {
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const exit = await Effect.runPromiseExit(
        scratchRun({
          command: [],
          mount: true,
          keep: false,
          answers: {},
          issues: [],
        }).pipe(Effect.provide(makeHarnessLayer(recorded)), Effect.provide(testSupportLayer())),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(Exit.causeOption(exit))).toContain("ScratchAppError");
      }
      expect(recorded.appliedPlans).toHaveLength(0);
    });
  });

  test("--keep converts the scratch to detached and skips the destroy", async () => {
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const layer = makeHarnessLayer(recorded);
      const result = await Effect.runPromise(
        scratchRun({
          command: ["echo", "ok"],
          mount: true,
          keep: true,
          answers: {},
          issues: [],
        }).pipe(Effect.provide(layer), Effect.provide(testSupportLayer())),
      );
      expect(result.kept).toBe(true);
      expect(recorded.execCalls).toHaveLength(1);
      expect(recorded.destroyCalls).toHaveLength(0);

      const summaries = await Effect.runPromise(
        scratchList().pipe(Effect.provide(layer), Effect.provide(testSupportLayer())),
      );
      const summary = summaries.find((entry) => entry.id === result.scratchId);
      expect(summary?.status).toBe("detached");
    });
  });

  test("interrupting a running exec destroys the scratch", async () => {
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const layer = makeHarnessLayer(recorded, { execNever: true });
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(
            scratchRun({
              command: ["sleep", "infinity"],
              mount: true,
              keep: false,
              answers: {},
              issues: [],
            }).pipe(Effect.provide(layer), Effect.provide(testSupportLayer())),
          );
          yield* Effect.gen(function* () {
            for (let attempt = 0; attempt < 500 && recorded.execCalls.length === 0; attempt += 1) {
              yield* Effect.sleep("5 millis");
            }
          });
          yield* Fiber.interrupt(fiber);
        }),
      );
      expect(recorded.execCalls).toHaveLength(1);
      expect(recorded.destroyCalls).toHaveLength(1);
    });
  });

  test("acquire input carries the recipe source, answers, cwd mount, and foreground lifetime", async () => {
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const captured: ScratchAcquireInput[] = [];
      await Effect.runPromise(
        scratchRun(
          {
            command: ["true"],
            from: "toolbox",
            mount: true,
            keep: false,
            answers: { name: "toolbox" },
            issues: [],
          },
          {
            ...defaultScratchRunDeps,
            acquireWithPlan: (input) => {
              captured.push(input);
              return defaultScratchRunDeps.acquireWithPlan(input);
            },
          },
        ).pipe(Effect.provide(makeHarnessLayer(recorded)), Effect.provide(testSupportLayer())),
      );
      expect(captured).toHaveLength(1);
      expect(captured[0]?.source).toEqual({ kind: "recipe", ref: "toolbox" });
      expect(captured[0]?.isolate).toBe("cwd");
      expect(captured[0]?.detached).toBe(false);
      expect(captured[0]?.mountCwd).toEqual({});
      expect(captured[0]?.answers).toEqual({ name: "toolbox" });
    });
  });

  test("--no-mount requests baked scratch isolation without a cwd mount", async () => {
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const captured: ScratchAcquireInput[] = [];
      await Effect.runPromise(
        scratchRun(
          {
            command: ["true"],
            mount: false,
            keep: false,
            answers: {},
            issues: [],
          },
          {
            ...defaultScratchRunDeps,
            acquireWithPlan: (input) => {
              captured.push(input);
              return defaultScratchRunDeps.acquireWithPlan(input);
            },
          },
        ).pipe(Effect.provide(makeHarnessLayer(recorded)), Effect.provide(testSupportLayer())),
      );
      expect(captured[0]?.isolate).toBe("baked");
      expect(captured[0]?.mountCwd).toBeUndefined();
    });
  });

  test("stdin TTY allocates a TTY on the provider exec", async () => {
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      await Effect.runPromise(
        scratchRun(
          {
            command: ["true"],
            mount: true,
            keep: false,
            answers: {},
            issues: [],
          },
          { ...defaultScratchRunDeps, stdinIsTty: () => true },
        ).pipe(Effect.provide(makeHarnessLayer(recorded)), Effect.provide(testSupportLayer())),
      );
      expect(recorded.execCalls[0]?.tty).toBe(true);
      expect(recorded.execCalls[0]?.stdin).toBe("inherit");
    });
  });
});

describe("scratch run cleanup and warm repeats", () => {
  const serviceBuildInputs = (plan: AppPlan): Record<string, unknown> => {
    const service = Object.values(plan.services)[0];
    if (service === undefined) throw new Error("scratch run plan has no service");
    return {
      type: service.type,
      artifact: service.artifact,
      command: service.command,
      entrypoint: service.entrypoint,
      user: service.user,
      workingDirectory: service.workingDirectory,
    };
  };

  test("a kept run is listed detached and reaped by gc --prune once its registry entry is lost", async () => {
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const layer = makeHarnessLayer(recorded, { execStdout: "ok\n" });
      const result = await Effect.runPromise(
        scratchRun({ command: ["echo", "ok"], mount: true, keep: true, answers: {}, issues: [] }).pipe(
          Effect.provide(layer),
          Effect.provide(testSupportLayer()),
        ),
      );
      expect(recorded.destroyCalls).toHaveLength(0);

      const listed = await Effect.runPromise(
        scratchList().pipe(Effect.provide(layer), Effect.provide(testSupportLayer())),
      );
      const summary = listed.find((entry) => entry.id === result.scratchId);
      expect(summary?.status).toBe("detached");
      expect(summary?.source).toEqual({ kind: "recipe", ref: "toolbox" });
      expect(summary?.mode).toBe("cwd");

      // Losing the registry entry (a wiped cache) turns the kept scratch into an
      // orphan whose cache dir and provider resources gc --prune then reaps.
      await Effect.runPromise(makeScratchRegistry().remove(result.scratchId));
      const gc = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) => service.gc({ prune: true })).pipe(
          Effect.provide(layer),
          Effect.provide(testSupportLayer()),
        ),
      );
      expect(gc.reaped).toEqual([result.scratchId]);
      expect(recorded.destroyCalls.map((call) => call.app)).toEqual([result.scratchId]);

      const afterGc = await Effect.runPromise(
        scratchList().pipe(Effect.provide(layer), Effect.provide(testSupportLayer())),
      );
      expect(afterGc).toEqual([]);
      const remaining = await readdir(makeLandoPaths().scratchDir);
      expect(remaining.filter((entry) => entry !== "registry.bin")).toEqual([]);
    });
  });

  test("interrupting a run leaves no registry entry or scratch root behind", async () => {
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const layer = makeHarnessLayer(recorded, { execNever: true });
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(
            scratchRun({
              command: ["sleep", "infinity"],
              mount: true,
              keep: false,
              answers: {},
              issues: [],
            }).pipe(Effect.provide(layer), Effect.provide(testSupportLayer())),
          );
          for (let attempt = 0; attempt < 500 && recorded.execCalls.length === 0; attempt += 1) {
            yield* Effect.sleep("5 millis");
          }
          yield* Fiber.interrupt(fiber);
        }),
      );
      expect(recorded.execCalls).toHaveLength(1);
      expect(recorded.destroyCalls).toHaveLength(1);

      const listed = await Effect.runPromise(
        scratchList().pipe(Effect.provide(layer), Effect.provide(testSupportLayer())),
      );
      expect(listed).toEqual([]);
      const remaining = await readdir(makeLandoPaths().scratchDir);
      expect(remaining.filter((entry) => entry !== "registry.bin")).toEqual([]);
    });
  });

  test("repeated toolbox runs acquire and destroy a fresh scratch with content-addressed build inputs and no warm pool", async () => {
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const layer = makeHarnessLayer(recorded, { execStdout: "ok\n" });
      const options = {
        command: ["echo", "ok"],
        mount: true,
        keep: false,
        answers: {},
        issues: [],
      } as const;

      const first = await Effect.runPromise(
        scratchRun(options).pipe(Effect.provide(layer), Effect.provide(testSupportLayer())),
      );
      const second = await Effect.runPromise(
        scratchRun(options).pipe(Effect.provide(layer), Effect.provide(testSupportLayer())),
      );

      expect(first.scratchId).not.toBe(second.scratchId);
      expect(recorded.appliedPlans).toHaveLength(2);
      const [firstPlan, secondPlan] = recorded.appliedPlans;
      if (firstPlan === undefined || secondPlan === undefined) {
        throw new Error("expected two applied plans");
      }
      expect(String(firstPlan.id)).not.toBe(String(secondPlan.id));

      expect(recorded.destroyCalls).toHaveLength(2);

      // Identical resolved image build inputs across runs — content-addressed recipe render.
      const firstInputs = serviceBuildInputs(firstPlan);
      expect(serviceBuildInputs(secondPlan)).toEqual(firstInputs);
      expect(firstInputs.artifact).toEqual({ kind: "ref", ref: "debian:12.11-slim" });

      const afterRuns = await Effect.runPromise(
        scratchList().pipe(Effect.provide(layer), Effect.provide(testSupportLayer())),
      );
      expect(afterRuns).toEqual([]);

      // Only a --keep run persists a scratch for later apps:scratch:* verbs; a plain
      // repeat still acquires and destroys a fresh scratch.
      const kept = await Effect.runPromise(
        scratchRun({ ...options, keep: true }).pipe(
          Effect.provide(layer),
          Effect.provide(testSupportLayer()),
        ),
      );
      expect(recorded.destroyCalls).toHaveLength(2);
      const afterKeep = await Effect.runPromise(
        scratchList().pipe(Effect.provide(layer), Effect.provide(testSupportLayer())),
      );
      expect(afterKeep.map((entry) => entry.id)).toEqual([kept.scratchId]);
      expect(afterKeep[0]?.status).toBe("detached");
    });
  });

  test("repeated toolbox runs reuse cached build results while preserving fresh scratch isolation", async () => {
    await withTempProject(async () => {
      const buildCalls: string[] = [];
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const layer = makeHarnessLayer(recorded, { buildCalls, execStdout: "ok\n" });
      const supportLayer = layer.pipe(Layer.provide(testSupportLayer()));
      await Effect.runPromise(
        Effect.gen(function* () {
          const options = { command: ["echo", "ok"], mount: true, keep: false, answers: {}, issues: [] };
          const first = yield* scratchRun(options);
          const second = yield* scratchRun(options);
          expect(first.scratchId).not.toBe(second.scratchId);
        }).pipe(Effect.provide(supportLayer)),
      );

      expect(buildCalls).toEqual([]);
      expect(recorded.appliedPlans).toHaveLength(2);
      expect(String(recorded.appliedPlans[0]?.id)).not.toBe(String(recorded.appliedPlans[1]?.id));
      expect(recorded.appliedPlans[0]?.root).not.toBe(recorded.appliedPlans[1]?.root);
      expect(recorded.execCalls).toHaveLength(2);
      expect(recorded.destroyCalls).toHaveLength(2);
      const afterRuns = await Effect.runPromise(scratchList().pipe(Effect.provide(supportLayer)));
      expect(afterRuns).toEqual([]);
    });
  });
});

describe("scratch run rendering", () => {
  const baseResult: ScratchRunResult = {
    scratchId: "scratch-toolbox-abc123",
    service: "toolbox",
    command: ["echo", "ok"],
    exitCode: 0,
    kept: false,
    stdout: "ok\n",
    stderr: "",
  };

  test("renders tool stdout without a duplicate trailing newline", () => {
    expect(renderScratchRunResult(baseResult)).toBe("ok");
  });

  test("prints the scratch id for a kept run", () => {
    const rendered = renderScratchRunResult({ ...baseResult, kept: true });
    expect(rendered).toContain("scratch-toolbox-abc123");
  });

  test("success exit code passes through only non-zero tool exits", () => {
    expect(scratchRunSuccessExitCode(baseResult)).toBeUndefined();
    expect(scratchRunSuccessExitCode({ ...baseResult, exitCode: 3 })).toBe(3);
  });

  test("human rendering includes captured tool stderr", () => {
    expect(
      renderScratchRunResult(
        { ...baseResult, stderr: "warn\n" },
        { mode: "plain", format: "text", columns: 80, isTTY: false },
      ),
    ).toBe("ok\nwarn");
  });

  test("json rendering leaves captured tool stderr for stream frames only", () => {
    expect(
      renderScratchRunResult(
        { ...baseResult, stderr: "warn\n" },
        { mode: "lando", format: "json", columns: 80, isTTY: false },
      ),
    ).toBe("ok");
  });

  test("json streaming does not duplicate captured tool stderr onto renderer stderr", async () => {
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const io = createBufferedRendererIO();
      const result = await Effect.runPromise(
        scratchRun({
          command: ["sh", "-c", "echo warn >&2"],
          mount: true,
          keep: false,
          answers: {},
          issues: [],
        }).pipe(
          Effect.provide(makeHarnessLayer(recorded, { execStderr: "warn\n" })),
          Effect.provide(testSupportLayer()),
          Effect.provide(makeJsonRendererServiceLive(io)),
        ),
      );

      expect(result.stderr).toBe("warn\n");
      expect(io.stderr()).toBe("");
    });
  });
});

describe("scratch run agent env forwarding", () => {
  const AGENT_KEYS = [
    "CLAUDECODE",
    "CLAUDE_CODE",
    "CURSOR_AGENT",
    "OPENCODE",
    "COPILOT_CLI",
    "GEMINI_CLI",
    "AGENT",
    "CI",
    "LANDO_AGENT_ENV",
  ] as const;

  const withHostEnv = async <A>(
    env: Record<string, string | undefined>,
    run: () => Promise<A>,
  ): Promise<A> => {
    const saved = new Map<string, string | undefined>();
    for (const key of AGENT_KEYS) saved.set(key, process.env[key]);
    try {
      for (const key of AGENT_KEYS) {
        const value = env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      return await run();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  const baseOptions = {
    command: ["env"],
    mount: true,
    keep: false,
    answers: {},
    issues: [],
  };

  test("forwards present agent markers from the host env into the scratch exec", async () => {
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      await withHostEnv({ OPENCODE: "1" }, () =>
        Effect.runPromise(
          scratchRun(baseOptions).pipe(
            Effect.provide(makeHarnessLayer(recorded)),
            Effect.provide(testSupportLayer()),
          ),
        ),
      );
      expect(recorded.execCalls).toHaveLength(1);
      expect(recorded.execCalls[0]?.env).toEqual({ OPENCODE: "1" });
    });
  });

  test("service environment wins: forwarded keys shadowed by the service env are dropped", async () => {
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const deps = {
        ...defaultScratchRunDeps,
        acquireWithPlan: (input: ScratchAcquireInput) =>
          defaultScratchRunDeps.acquireWithPlan(input).pipe(
            Effect.map(({ handle, plan }) => {
              const services = { ...plan.services };
              for (const key of Object.keys(services) as Array<keyof typeof services>) {
                const service = services[key];
                if (service === undefined) continue;
                services[key] = { ...service, environment: { ...service.environment, CI: "in-service" } };
              }
              return { handle, plan: { ...plan, services } };
            }),
          ),
      };
      await withHostEnv({ OPENCODE: "1", CI: "true" }, () =>
        Effect.runPromise(
          scratchRun(baseOptions, deps).pipe(
            Effect.provide(makeHarnessLayer(recorded)),
            Effect.provide(testSupportLayer()),
          ),
        ),
      );
      expect(recorded.execCalls[0]?.env).toEqual({ OPENCODE: "1" });
    });
  });

  test("LANDO_AGENT_ENV=0 disables forwarding for the invocation", async () => {
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      await withHostEnv({ OPENCODE: "1", LANDO_AGENT_ENV: "0" }, () =>
        Effect.runPromise(
          scratchRun(baseOptions).pipe(
            Effect.provide(makeHarnessLayer(recorded)),
            Effect.provide(testSupportLayer()),
          ),
        ),
      );
      expect(recorded.execCalls[0]?.env).toBeUndefined();
    });
  });

  test("global agentEnv.enabled=false disables forwarding", async () => {
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      await withHostEnv({ OPENCODE: "1" }, () =>
        Effect.runPromise(
          scratchRun(baseOptions).pipe(
            Effect.provide(
              makeHarnessLayer(recorded, { configLayer: agentEnvConfigServiceLayer({ enabled: false }) }),
            ),
            Effect.provide(testSupportLayer()),
          ),
        ),
      );
      expect(recorded.execCalls[0]?.env).toBeUndefined();
    });
  });

  test("a rendered landofile agentEnv:false opt-out disables forwarding", async () => {
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const optOutLandofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "toolbox",
        agentEnv: false,
      });
      const deps = {
        ...defaultScratchRunDeps,
        readLandofile: () => Effect.succeed(optOutLandofile),
      };
      await withHostEnv({ OPENCODE: "1" }, () =>
        Effect.runPromise(
          scratchRun(baseOptions, deps).pipe(
            Effect.provide(makeHarnessLayer(recorded)),
            Effect.provide(testSupportLayer()),
          ),
        ),
      );
      expect(recorded.execCalls[0]?.env).toBeUndefined();
    });
  });
});

describe("readScratchLandofile", () => {
  test("decodes the rendered scratch landofile including the agentEnv opt-out", async () => {
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const layer = makeHarnessLayer(recorded);
      const result = await Effect.runPromise(
        scratchRun({
          command: ["true"],
          mount: true,
          keep: true,
          answers: {},
          issues: [],
        }).pipe(Effect.provide(layer), Effect.provide(testSupportLayer())),
      );
      const landofile = await Effect.runPromise(
        readScratchLandofile(result.scratchId).pipe(
          Effect.provide(layer),
          Effect.provide(testSupportLayer()),
        ),
      );
      expect(landofile.name).toBeDefined();
      expect(landofile.agentEnv).toBeUndefined();

      const paths = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) => service.paths(result.scratchId)).pipe(
          Effect.provide(layer),
          Effect.provide(testSupportLayer()),
        ),
      );
      const file = join(paths.root, ".lando.yml");
      await writeFile(file, `${await readFile(file, "utf8")}\nagentEnv: false\n`);
      const updated = await Effect.runPromise(
        readScratchLandofile(result.scratchId).pipe(
          Effect.provide(layer),
          Effect.provide(testSupportLayer()),
        ),
      );
      expect(updated.agentEnv).toBe(false);
    });
  });
});

describe("scratch run streaming spec", () => {
  const baseResult: ScratchRunResult = {
    scratchId: "scratch-toolbox-abc123",
    service: "toolbox",
    command: ["echo", "ok"],
    exitCode: 0,
    kept: false,
    stdout: "ok\n",
    stderr: "warn\n",
  };

  test("declares the shared StreamFrame schema", () => {
    expect(appsScratchRunSpec.streaming).toBe(StreamFrame);
  });

  test("maps stdout and stderr onto service-tagged stream frames", () => {
    expect(appsScratchRunSpec.streamFrames?.(baseResult)).toEqual([
      { _tag: "stdout", service: "toolbox", chunk: "ok\n" },
      { _tag: "stderr", service: "toolbox", chunk: "warn\n" },
    ]);
    expect(appsScratchRunSpec.streamFrames?.({ ...baseResult, stdout: "", stderr: "" })).toEqual([]);
  });
});
