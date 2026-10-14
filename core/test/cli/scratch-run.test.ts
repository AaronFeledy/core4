import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  type AppPlan,
  LandofileShape,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
  StreamFrame,
} from "@lando/core/schema";
import {
  type ApplyOptions,
  type CommandSpec,
  type ConfigService,
  type EventService,
  type ExecChunk,
  PathsService,
  RuntimeProvider,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  type ScratchAcquireInput,
  ScratchAppService,
} from "@lando/core/services";
import type { LandofileRuntimeInputs } from "@lando/landofile/ports";
import { Effect, Exit, Fiber, Layer, Schema, Stream } from "effect";

import * as BunDataMover from "@lando/data-mover/service";
import * as AppCacheService from "@lando/engine/cache/service";
import { AGENT_CONTEXT_ENV_ALLOWLIST } from "@lando/engine/config/agent-env";
import { StreamFrameSink, type StreamFrameSinkFrame } from "@lando/engine/operations/stream-frame-sink";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as ScratchRegistryLayer from "@lando/engine/scratch-app/registry";
import { makeScratchRegistry } from "@lando/engine/scratch-app/registry";
import * as ScratchResourceScannerLayer from "@lando/engine/scratch-app/scanner";
import * as ScratchAppServiceLayer from "@lando/engine/scratch-app/service";
import { readScratchLandofile } from "@lando/engine/scratch-app/service";
import * as BuildOrchestratorLayer from "@lando/engine/services/build-orchestrator";
import * as LandoConfigService from "@lando/engine/services/config";
import * as LandoEventService from "@lando/engine/services/event-service";
import * as BunFileSystem from "@lando/engine/services/file-system";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import * as BunProcessRunner from "@lando/engine/services/process-runner";
import * as EnvSecretStore from "@lando/engine/services/secret-store";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService, resetRegisteredRedactionValuesForTesting } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import * as RendererOutput from "@lando/renderer/output";
import * as RendererRuntime from "@lando/renderer/runtime";
import { ServiceExecError } from "@lando/sdk/errors";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import * as StateStoreLayer from "@lando/state-store/service";
const stateStoreLayer = StateStoreLayer.layer.pipe(
  Layer.provide(Layer.mergeAll(BunProcessRunner.layer, PrivateFileAccessService.layer)),
);
import { FinishCommandProgress } from "../../src/cli/command-progress.ts";
import { appsScratchRunSpec } from "../../src/cli/command-specs/apps/scratch/run.ts";
import {
  type ScratchRunResult,
  defaultScratchRunDeps,
  normalizeScratchRunArgvForParsing,
  parseScratchRunArgv,
  scratchRun,
  scratchRunHasCommandTail,
  scratchRunOptionsFromInput,
  scratchRunSuccessExitCode,
} from "../../src/cli/commands/scratch-run.ts";
import { scratchList } from "../../src/cli/commands/scratch.ts";
import { resolveResultFormat } from "../../src/cli/format-flags.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { BUNDLED_PLUGIN_MODULES } from "../../src/plugins/generated/bundled.ts";
import * as ScratchInitAppPortLayer from "../../src/runtime/scratch-init-port.ts";
import * as TestLandofileServiceLayer from "../_support/landofile-layer.ts";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";
import { agentEnvConfigServiceLayer } from "./agent-env-test-config.ts";

const providerId = ProviderId.make("lando");

const landofileRuntimeInputs = {
  ports: {
    resolveUserCacheRoot: () => process.env.LANDO_USER_CACHE_ROOT ?? tmpdir(),
    resolveUserIncludesDir: () => tmpdir(),
    npmRecipeSource: {
      resolve: (packageSpec) =>
        Promise.resolve({
          packageName: packageSpec,
          version: "0.0.0",
          dist: { tarball: "https://example.test/unused.tgz" },
        }),
    },
    git: { clone: () => Promise.resolve({ commitSha: "unused" }) },
    tarball: {
      fetch: () => Promise.resolve(new Uint8Array()),
      extract: () => Promise.resolve(),
    },
    publication: { publish: () => Promise.resolve() },
  },
  templates: { modules: BUNDLED_PLUGIN_MODULES },
} satisfies LandofileRuntimeInputs;

const landofileServiceLayer = TestLandofileServiceLayer.layerWithInputs(landofileRuntimeInputs);
const pluginRegistryLive = PluginRegistryLayer.layerWith({}, BUNDLED_PLUGIN_MODULES);

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
  architectureEmulation: false,
  composeSpec: "portable",
  providerExtensions: [],
};

interface ExecCall extends CommandSpec {
  readonly app: string;
  readonly service: string;
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
  readonly applyOptions?: ApplyOptions[];
  readonly buildCalls?: string[];
  readonly artifactBuild?: boolean;
  readonly artifactPull?: boolean;
  readonly execExitCode?: number;
  readonly execStdout?: string;
  readonly execStderr?: string;
  readonly execNever?: boolean;
  readonly execStream?: RuntimeProviderShape["execStream"];
  readonly onExec?: (spec: CommandSpec) => void;
  readonly onApply?: () => void;
  readonly execStarted?: () => void;
  readonly configLayer?: Layer.Layer<ConfigService>;
}

const die = (operation: string) =>
  Effect.die(new Error(`scratch run test provider should not call ${operation}`));

const makeHarnessLayer = (recorded: Recorded, options: HarnessOptions = {}) => {
  const provider: RuntimeProviderShape = RuntimeProvider.of({
    id: String(providerId),
    displayName: "Scratch Run Test Provider",
    version: "0.0.0",
    platform: "linux",
    capabilities: {
      ...capabilities,
      artifactBuild: options.artifactBuild ?? capabilities.artifactBuild,
      artifactPull: options.artifactPull ?? capabilities.artifactPull,
    },
    isAvailable: Effect.succeed(true),
    planSetup: () => Effect.succeed({ providerId, changes: [] }),
    setup: () => Effect.void,
    getStatus: Effect.succeed({ running: true, message: "ready" }),
    getVersions: Effect.succeed({ provider: "0.0.0" }),
    buildArtifact: (spec) =>
      Effect.sync(() => {
        options.buildCalls?.push(String(spec.service));
        return options.artifactPull
          ? { providerId, ref: `${spec.service}:built`, digest: "sha256:built" }
          : { providerId, ref: `${spec.service}:built` };
      }),
    pullArtifact: (spec) =>
      Effect.sync(() => {
        return { providerId, ref: spec.ref, digest: "sha256:source" };
      }),
    removeArtifact: () => Effect.void,
    apply: (plan, applyOptions) =>
      Effect.sync(() => {
        recorded.appliedPlans.push(plan);
        options.onApply?.();
        options.applyOptions?.push(applyOptions);
        return { changed: true };
      }),
    start: () => die("start"),
    stop: () => die("stop"),
    restart: () => die("restart"),
    waitForExit: () => Effect.succeed({ exitCode: 0 }),
    destroy: (target, destroyOptions) =>
      Effect.sync(() => {
        recorded.destroyCalls.push({ app: String(target.app), volumes: destroyOptions.volumes });
        return { kind: "destroyed" as const };
      }),
    removeObservedService: () => Effect.succeed({ kind: "absent" as const }),
    exec: () => die("exec"),
    execStream: (target, spec) => {
      const record = Effect.sync(() => {
        recorded.execCalls.push({
          app: String(target.app),
          service: String(target.service),
          ...spec,
        });
        options.onExec?.(spec);
        options.execStarted?.();
      });
      return Stream.unwrap(
        record.pipe(
          Effect.as(
            options.execNever === true
              ? Stream.never
              : (options.execStream?.(target, spec) ??
                  Stream.fromIterable<ExecChunk>([
                    { kind: "stdout", chunk: new TextEncoder().encode(options.execStdout ?? "") },
                    { kind: "stderr", chunk: new TextEncoder().encode(options.execStderr ?? "") },
                    { exitCode: options.execExitCode ?? 0 },
                  ])),
          ),
        ),
      );
    },
    run: () => die("run"),
    runStream: () => Stream.die("scratch run test provider should not call runStream"),
    logs: () => Stream.empty,
    inspect: () => die("inspect"),
    list: () => Effect.succeed([]),
    snapshotVolume: () => die("snapshotVolume"),
    restoreVolume: () => die("restoreVolume"),
    locateVolume: () => die("locateVolume"),
    listVolumes: () => Effect.succeed([]),
    removeVolume: () => die("removeVolume"),
    copyToService: () => die("copyToService"),
    copyFromService: () => Stream.die("scratch run test provider should not call copyFromService"),
    exportArtifact: () => Stream.die("scratch run test provider should not call exportArtifact"),
    importArtifact: () => die("importArtifact"),
  });

  const plannerLive = AppPlannerLayer.layer.pipe(
    Layer.provide(Layer.mergeAll(pluginRegistryLive, AppCacheService.layer, LandoConfigService.layer)),
  );
  const redactionLive = RedactionService.layer.pipe(Layer.provide(EnvSecretStore.layer));
  const eventLive = LandoEventService.layer.pipe(Layer.provide(redactionLive));
  const pathsLive = Layer.succeed(PathsService, makeLandoPaths());
  const registryLive = Layer.succeed(
    RuntimeProviderRegistry,
    RuntimeProviderRegistry.of({
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    }),
  );
  const scratchDeps = Layer.mergeAll(
    BunFileSystem.layer,
    PrivateFileAccessService.layer,
    landofileServiceLayer,
    plannerLive,
    registryLive,
    eventLive,
    pathsLive,
    redactionLive,
    ScratchRegistryLayer.ScratchRegistry.layer,
    ScratchResourceScannerLayer.ScratchResourceScanner.layer,
    ScratchInitAppPortLayer.layer,
    BunDataMover.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          stateStoreLayer,
          eventLive,
          redactionLive,
          pathsLive,
          Layer.succeed(RuntimeProvider, provider),
        ),
      ),
    ),
  );
  const buildOrchestratorLive = BuildOrchestratorLayer.layer.pipe(
    Layer.provide(Layer.mergeAll(eventLive, pathsLive, registryLive, stateStoreLayer)),
  );
  return Layer.mergeAll(
    scratchDeps,
    buildOrchestratorLive,
    ScratchAppServiceLayer.layerWith(landofileRuntimeInputs).pipe(
      Layer.provide(Layer.mergeAll(scratchDeps, buildOrchestratorLive)),
    ),
    options.configLayer ?? LandoConfigService.layer,
    EnvSecretStore.layer,
  ).pipe(Layer.provide(PrivateFileAccessService.layer));
};

const testSupportLayer = (): Layer.Layer<EventService | RedactionService> => {
  const redactionLive = RedactionService.layer.pipe(Layer.provide(EnvSecretStore.layer));
  return Layer.mergeAll(redactionLive, LandoEventService.layer.pipe(Layer.provide(redactionLive)));
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
  test("resolves exact service environment secrets only in transient provider options", async () => {
    await withTempProject(async (dir) => {
      const previous = process.env.LANDO_SECRET_SCRATCH_TOKEN;
      process.env.LANDO_SECRET_SCRATCH_TOKEN = "resolved-scratch-token";
      try {
        await writeFile(
          join(dir, ".lando.yml"),
          [
            "name: scratch-secret",
            "services:",
            "  web:",
            "    type: compose",
            "    home: false",
            "    primary: true",
            "    image: alpine:latest",
            "    environment:",
            "      TOKEN: '${secret:SCRATCH_TOKEN}'",
            "",
          ].join("\n"),
        );
        const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
        const applyOptions: ApplyOptions[] = [];

        await Effect.runPromise(
          Effect.scoped(
            Effect.flatMap(ScratchAppService, (scratch) =>
              scratch.acquire({ source: { kind: "fork" }, detached: false, isolate: "cwd" }),
            ),
          ).pipe(
            Effect.provide(makeHarnessLayer(recorded, { applyOptions })),
            Effect.provide(testSupportLayer()),
          ),
        );

        expect(applyOptions[0]?.serviceEnvironment?.[ServiceName.make("web")]).toEqual({
          TOKEN: "resolved-scratch-token",
        });
        expect(recorded.appliedPlans[0]?.services[ServiceName.make("web")]?.environment).toEqual({
          LANDO_HOST_IP: "host.lando.internal",
          TOKEN: "${secret:SCRATCH_TOKEN}",
        });
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, "LANDO_SECRET_SCRATCH_TOKEN");
        else process.env.LANDO_SECRET_SCRATCH_TOKEN = previous;
      }
    });
  });

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
          "    home: false",
          "    primary: true",
          "    build:",
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
        const failure = Exit.getCause(exit);
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
        expect(JSON.stringify(Exit.getCause(exit))).toContain("ScratchAppError");
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
      const ready = Promise.withResolvers<void>();
      const stages: string[] = [];
      const layer = makeHarnessLayer(recorded, {
        execNever: true,
        execStarted: () => ready.resolve(),
        onExec: () => {
          stages.push("exec");
        },
      });
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            scratchRun({
              command: ["sleep", "infinity"],
              mount: true,
              keep: false,
              answers: {},
              issues: [],
              hostIo: "cli",
            }).pipe(
              Effect.provide(layer),
              Effect.provide(testSupportLayer()),
              Effect.provideService(
                FinishCommandProgress,
                Effect.sync(() => {
                  stages.push("finish");
                }),
              ),
            ),
          );
          yield* Effect.promise(() => ready.promise);
          yield* Fiber.interrupt(fiber);
        }),
      );
      expect(recorded.execCalls).toHaveLength(1);
      expect(recorded.destroyCalls).toHaveLength(1);
      expect(stages).toEqual(["finish", "exec"]);
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

  test("non-CLI scratch execution does not inherit the host terminal", async () => {
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
          defaultScratchRunDeps,
        ).pipe(Effect.provide(makeHarnessLayer(recorded)), Effect.provide(testSupportLayer())),
      );
      expect(recorded.execCalls[0]?.tty).toBeUndefined();
      expect(recorded.execCalls[0]?.stdin).toBeUndefined();
      expect(recorded.execCalls[0]?.stdinStream).toBeUndefined();
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
      await Effect.runPromise(makeScratchRegistry(ownerOnlyFileAccess).remove(result.scratchId));
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
      const ready = Promise.withResolvers<void>();
      const layer = makeHarnessLayer(recorded, { execNever: true, execStarted: () => ready.resolve() });
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            scratchRun({
              command: ["sleep", "infinity"],
              mount: true,
              keep: false,
              answers: {},
              issues: [],
            }).pipe(Effect.provide(layer), Effect.provide(testSupportLayer())),
          );
          yield* Effect.promise(() => ready.promise);
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
      const layer = makeHarnessLayer(recorded, { artifactBuild: true, execStdout: "ok\n" });
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
      expect(firstInputs.artifact).toEqual({ kind: "ref", ref: "toolbox:built" });

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
      const layer = makeHarnessLayer(recorded, {
        artifactBuild: true,
        artifactPull: true,
        buildCalls,
        execStdout: "ok\n",
      });
      const supportLayer = layer.pipe(Layer.provide(testSupportLayer()));
      await Effect.runPromise(
        Effect.gen(function* () {
          const options = { command: ["echo", "ok"], mount: true, keep: false, answers: {}, issues: [] };
          const first = yield* scratchRun(options);
          const second = yield* scratchRun(options);
          expect(first.scratchId).not.toBe(second.scratchId);
        }).pipe(Effect.provide(supportLayer)),
      );

      expect(buildCalls).toEqual(["toolbox"]);
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

  test("streams tool stdout byte-exact without a duplicate trailing newline", async () => {
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const chunks: string[] = [];
      await Effect.runPromise(
        scratchRun({ command: ["echo", "ok"], mount: false, keep: false, answers: {}, issues: [] }).pipe(
          Effect.provide(makeHarnessLayer(recorded, { execStdout: "ok\n" })),
          Effect.provide(testSupportLayer()),
          Effect.provideService(StreamFrameSink, {
            emit: (frame) =>
              Effect.sync(() => {
                chunks.push(frame.chunk);
              }),
          }),
        ),
      );
      expect(chunks.join("")).toBe("ok\n");
    });
  });

  test("prints the kept scratch id on human stderr, not tool stdout", async () => {
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const io = createBufferedRendererIO();
      const result = await Effect.runPromise(
        scratchRun({
          command: ["echo", "ok"],
          mount: false,
          keep: true,
          answers: {},
          issues: [],
          hostIo: "cli",
        }).pipe(
          Effect.provide(makeHarnessLayer(recorded, { execStdout: "ok\n" })),
          Effect.provide(testSupportLayer()),
          Effect.provide(RendererRuntime.layerPlainService(io)),
        ),
      );
      expect(io.stderr()).toBe(`kept: ${result.scratchId}\n`);
      expect(io.stdout()).toBe("");
      expect(result.stdout).toBe("ok\n");
      expect(result.kept).toBe(true);
      expect(recorded.destroyCalls).toHaveLength(0);
    });
  });

  test("success exit code passes through only non-zero tool exits", () => {
    expect(scratchRunSuccessExitCode(baseResult)).toBeUndefined();
    expect(scratchRunSuccessExitCode({ ...baseResult, exitCode: 3 })).toBe(3);
  });

  test("human streaming sends tool stderr to the stderr sink", async () => {
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const frames: StreamFrameSinkFrame[] = [];
      await Effect.runPromise(
        scratchRun({ command: ["true"], mount: false, keep: false, answers: {}, issues: [] }).pipe(
          Effect.provide(makeHarnessLayer(recorded, { execStderr: "warn\n" })),
          Effect.provide(testSupportLayer()),
          Effect.provideService(StreamFrameSink, {
            emit: (frame) =>
              Effect.sync(() => {
                frames.push(frame);
              }),
          }),
        ),
      );
      expect(frames).toEqual([{ _tag: "stderr", chunk: "warn\n", raw: true }]);
    });
  });

  test("live JSON emits tool frames and one terminal result without a human kept notice", async () => {
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const io = createBufferedRendererIO();
      const streaming = appsScratchRunSpec.streaming;
      if (streaming === undefined) throw new TypeError("scratch run must declare stream frames");
      const streamingMode =
        typeof appsScratchRunSpec.streamingMode === "function"
          ? appsScratchRunSpec.streamingMode({})
          : appsScratchRunSpec.streamingMode;
      await runWithRendererHandling(
        appsScratchRunSpec.run({
          argv: ["--no-mount", "--keep", "--", "cat"],
          hostIo: "cli",
          flags: { format: "json" },
        }),
        {
          runtime: makeHarnessLayer(recorded, { execStdout: "piped-in\n", execStderr: "warn\n" }).pipe(
            Layer.provide(testSupportLayer()),
          ),
          rendererMode: "plain",
          resultFormat: "json",
          streaming,
          ...(streamingMode === undefined ? {} : { streamingMode }),
          io,
          resultSchema: appsScratchRunSpec.resultSchema,
          formatError: String,
        },
      );
      const frames = io
        .stdout()
        .trim()
        .split("\n")
        .map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line)));
      expect(frames).toHaveLength(3);
      expect(frames[0]).toMatchObject({ _tag: "stdout", chunk: "piped-in\n" });
      expect(frames[1]).toMatchObject({ _tag: "stderr", chunk: "warn\n" });
      expect(frames[2]).toMatchObject({ _tag: "result", envelope: { result: { kept: true } } });
      expect(io.stderr()).toBe("");
    });
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
          Effect.provide(RendererRuntime.layerJsonService(io)),
        ),
      );

      expect(result.stderr).toBe("warn\n");
      expect(io.stderr()).toBe("");
    });
  });
});

describe("scratch run agent env forwarding", () => {
  const AGENT_KEYS = [...AGENT_CONTEXT_ENV_ALLOWLIST, "LANDO_AGENT_ENV"] as const;

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

  test("redacts forwarded agent env values from live tool output", async () => {
    await withTempProject(async () => {
      const secret = "opencode-forwarded-secret";
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const io = createBufferedRendererIO();
      try {
        await withHostEnv({ OPENCODE: secret }, () =>
          Effect.runPromise(
            scratchRun(baseOptions).pipe(
              Effect.provide(makeHarnessLayer(recorded, { execStdout: `OPENCODE=${secret}\n` })),
              Effect.provide(RendererOutput.layerStreamFrameSink("text")),
              Effect.provide(testSupportLayer()),
              Effect.provide(RendererRuntime.layerPlainService(io)),
            ),
          ),
        );
      } finally {
        resetRegisteredRedactionValuesForTesting();
      }
      expect(recorded.execCalls[0]?.env).toEqual({ OPENCODE: secret });
      expect(io.stdout()).not.toContain(secret);
      expect(io.stdout()).toContain("OPENCODE=[redacted]");
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
  test("declares the shared StreamFrame schema", () => {
    expect(appsScratchRunSpec.streaming).toBe(StreamFrame);
  });

  test("delivers the first chunk before exit and retires progress before starting exec", async () => {
    // Given
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const firstChunk = Promise.withResolvers<void>();
      const finishTool = Promise.withResolvers<void>();
      const stages: string[] = [];
      const chunks: string[] = [];
      const layer = makeHarnessLayer(recorded, {
        onApply: () => {
          stages.push("acquire");
        },
        onExec: () => {
          stages.push("exec");
        },
        execStream: () =>
          Stream.concat(
            Stream.fromIterable<ExecChunk>([{ kind: "stdout", chunk: new TextEncoder().encode("prompt> ") }]),
            Stream.fromEffect(
              Effect.promise(() => finishTool.promise).pipe(Effect.as<ExecChunk>({ exitCode: 7 })),
            ),
          ),
      });
      const program = scratchRun({
        command: ["cat"],
        mount: false,
        keep: false,
        answers: {},
        issues: [],
        hostIo: "cli",
      }).pipe(
        Effect.provide(layer),
        Effect.provide(testSupportLayer()),
        Effect.provideService(
          FinishCommandProgress,
          Effect.sync(() => {
            stages.push("finish");
          }),
        ),
        Effect.provideService(StreamFrameSink, {
          emit: (frame) =>
            Effect.sync(() => {
              chunks.push(frame.chunk);
              firstChunk.resolve();
            }),
        }),
      );
      // When
      const completion = Effect.runPromise(program);
      try {
        await firstChunk.promise;
        // Then
        expect(chunks).toEqual(["prompt> "]);
        expect(stages).toEqual(["acquire", "finish", "exec"]);
        expect(recorded.destroyCalls).toHaveLength(0);
      } finally {
        finishTool.resolve();
      }
      const result = await completion;
      expect(result.exitCode).toBe(7);
      expect(recorded.destroyCalls).toHaveLength(1);
    });
  });

  test("a failed progress teardown prevents exec and still destroys scratch resources", async () => {
    // Given
    await withTempProject(async () => {
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      // When
      const exit = await Effect.runPromiseExit(
        scratchRun({
          command: ["cat"],
          mount: false,
          keep: false,
          answers: {},
          issues: [],
          hostIo: "cli",
        }).pipe(
          Effect.provide(makeHarnessLayer(recorded)),
          Effect.provide(testSupportLayer()),
          Effect.provideService(FinishCommandProgress, Effect.die(new TypeError("teardown failed"))),
        ),
      );
      // Then
      expect(Exit.isFailure(exit)).toBe(true);
      expect(recorded.execCalls).toHaveLength(0);
      expect(recorded.destroyCalls).toHaveLength(1);
    });
  });

  test.each(["provider failure", "interruption"] as const)(
    "restores keyboard raw mode and destroys scratch on %s",
    async (mode) => {
      // Given
      await withTempProject(async () => {
        let raw = false;
        const modes: boolean[] = [];
        const input = Object.assign(new PassThrough(), {
          isTTY: true,
          setRawMode: (value: boolean) => {
            raw = value;
            modes.push(value);
          },
        });
        Object.defineProperty(input, "isRaw", { get: () => raw });
        const descriptor = Object.getOwnPropertyDescriptor(process, "stdin");
        if (descriptor === undefined) throw new TypeError("missing stdin descriptor");
        const controller = new AbortController();
        const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
        const layer = makeHarnessLayer(recorded, {
          execNever: mode === "interruption",
          onApply: () => {
            expect(raw).toBe(false);
          },
          onExec: () => {
            expect(raw).toBe(true);
            if (mode === "interruption") controller.abort();
          },
          execStream: () =>
            Stream.fail(
              new ServiceExecError({
                providerId: "lando",
                operation: "exec",
                service: "toolbox",
                message: "exec failed",
              }),
            ),
        });
        Object.defineProperty(process, "stdin", { configurable: true, value: input });
        try {
          // When
          const exit = await Effect.runPromiseExit(
            scratchRun({
              command: ["cat"],
              mount: false,
              keep: false,
              answers: {},
              issues: [],
              hostIo: "cli",
              tty: true,
              signal: controller.signal,
            }).pipe(
              Effect.provide(layer),
              Effect.provide(testSupportLayer()),
              Effect.provideService(
                FinishCommandProgress,
                Effect.sync(() => {
                  expect(raw).toBe(false);
                }),
              ),
            ),
            { signal: controller.signal },
          );
          // Then
          expect(Exit.isFailure(exit)).toBe(true);
          expect(modes).toEqual([true, false]);
          expect(raw).toBe(false);
          expect(recorded.execCalls).toHaveLength(1);
          expect(recorded.destroyCalls).toHaveLength(1);
        } finally {
          Object.defineProperty(process, "stdin", descriptor);
          input.destroy();
        }
      });
    },
  );

  test.each([
    {
      stdinTTY: false,
      stdoutTTY: false,
      format: "text",
      rendererMode: "plain",
      cli: true,
      keyboard: false,
      attached: true,
      retire: true,
    },
    {
      stdinTTY: false,
      stdoutTTY: true,
      format: "json",
      rendererMode: "lando",
      cli: true,
      keyboard: false,
      attached: true,
      retire: false,
    },
    {
      stdinTTY: false,
      stdoutTTY: true,
      format: "yaml",
      rendererMode: "lando",
      cli: true,
      keyboard: false,
      attached: true,
      retire: false,
    },
    {
      stdinTTY: true,
      stdoutTTY: true,
      format: "text",
      rendererMode: "lando",
      cli: true,
      keyboard: true,
      attached: true,
      retire: true,
    },
    {
      stdinTTY: true,
      stdoutTTY: false,
      format: "text",
      rendererMode: "lando",
      cli: true,
      keyboard: false,
      attached: false,
      retire: true,
    },
    {
      stdinTTY: true,
      stdoutTTY: true,
      format: "text",
      rendererMode: "json",
      cli: true,
      keyboard: false,
      attached: false,
      retire: true,
    },
    {
      stdinTTY: true,
      stdoutTTY: true,
      format: "json",
      rendererMode: "lando",
      cli: true,
      keyboard: false,
      attached: false,
      retire: false,
    },
    {
      stdinTTY: true,
      stdoutTTY: true,
      format: "text",
      rendererMode: "lando",
      cli: false,
      keyboard: false,
      attached: false,
      retire: false,
    },
    {
      stdinTTY: false,
      stdoutTTY: false,
      format: "text",
      rendererMode: "plain",
      cli: true,
      nonInteractive: true,
      keyboard: false,
      attached: false,
      retire: false,
    },
  ])("applies scratch host IO only at the CLI boundary: %j", async (scenario) => {
    // Given
    await withTempProject(async () => {
      let raw = false;
      const rawChanges: boolean[] = [];
      const input = Object.assign(new PassThrough(), {
        isTTY: scenario.stdinTTY,
        setRawMode: (value: boolean) => {
          raw = value;
          rawChanges.push(value);
        },
      });
      Object.defineProperty(input, "isRaw", { get: () => raw });
      const payload = scenario.keyboard ? "typed\x03\n" : "piped-in\n";
      input.end(payload);
      const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
      const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      if (stdinDescriptor === undefined) throw new TypeError("missing stdin descriptor");
      const recorded: Recorded = { appliedPlans: [], destroyCalls: [], execCalls: [] };
      const stages: string[] = [];
      const controller = new AbortController();
      const layer = makeHarnessLayer(recorded, {
        onApply: () => {
          stages.push(`acquire:${raw}`);
        },
        onExec: () => {
          stages.push(`exec:${raw}`);
        },
        execStream: (_target, spec) =>
          Stream.unwrap(
            Effect.promise(async () => {
              let received = "";
              if (spec.stdinStream !== undefined)
                for await (const bytes of spec.stdinStream) received += new TextDecoder().decode(bytes);
              return Stream.fromIterable<ExecChunk>([
                { kind: "stdout", chunk: new TextEncoder().encode(received) },
                { exitCode: 0 },
              ]);
            }),
          ),
      });
      Object.defineProperty(process, "stdin", { configurable: true, value: input });
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: scenario.stdoutTTY });
      try {
        // When
        const result = await Effect.runPromise(
          appsScratchRunSpec
            .run({
              argv: ["--no-mount", "--", "cat"],
              flags: { format: scenario.format },
              rendererMode: scenario.rendererMode,
              ...(scenario.cli ? { hostIo: "cli" } : {}),
              ...("nonInteractive" in scenario ? { interaction: "non-interactive" } : {}),
              signal: controller.signal,
            })
            .pipe(
              Effect.provide(layer),
              Effect.provide(testSupportLayer()),
              Effect.provideService(
                FinishCommandProgress,
                Effect.sync(() => {
                  stages.push(`finish:${raw}`);
                }),
              ),
            ),
        );
        // Then
        expect(result.stdout).toBe(scenario.attached ? payload : "");
        expect(recorded.execCalls[0]?.tty === true).toBe(scenario.keyboard);
        expect(recorded.execCalls[0]?.stdinStream !== undefined).toBe(scenario.attached);
        expect(recorded.execCalls[0]?.terminalResize !== undefined).toBe(scenario.keyboard);
        expect(recorded.execCalls[0]?.signal).toBe(controller.signal);
        expect(controller.signal.aborted).toBe(false);
        expect(stages).toEqual([
          "acquire:false",
          ...(scenario.retire ? ["finish:false"] : []),
          `exec:${scenario.keyboard}`,
        ]);
        expect(rawChanges).toEqual(scenario.keyboard ? [true, false] : []);
        expect(raw).toBe(false);
        if (!scenario.cli || "nonInteractive" in scenario) expect(input.read()).toEqual(Buffer.from(payload));
        expect(recorded.destroyCalls).toHaveLength(1);
      } finally {
        Object.defineProperty(process, "stdin", stdinDescriptor);
        if (stdoutDescriptor === undefined) Reflect.deleteProperty(process.stdout, "isTTY");
        else Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
        input.destroy();
      }
    });
  });
});
