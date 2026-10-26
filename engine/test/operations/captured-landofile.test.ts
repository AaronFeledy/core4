import { expect, test } from "bun:test";
import { LandofileParseError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type CurrentExecutableAppPlan,
  GlobalConfig,
  type LandofileShape,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  type CommandSpec,
  ConfigService,
  type ExecTarget,
  LandofileService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { DateTime, Effect, Layer, Result, Schema, Stream } from "effect";
import type { ResolvedAppTarget } from "../../src/landofile/app-resolution.ts";
import { execApp } from "../../src/operations/exec.ts";
import { infoApp } from "../../src/operations/info.ts";
import { runTooling } from "../../src/operations/tooling.ts";
import * as ProviderExecToolingEngine from "../../src/services/tooling-engine.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";
import { testEnvironmentResolverLayer } from "../environment-values.ts";

const fixture = () => {
  const metadata = {
    resolvedAt: DateTime.makeUnsafe("2026-05-18T00:00:00Z"),
    source: "captured",
    runtime: 4 as const,
  };
  const name = ServiceName.make("web");
  const providerId = ProviderId.make("test");
  const plan: CurrentExecutableAppPlan = {
    valueModel: 1,
    id: AppId.make("captured"),
    name: "captured",
    slug: "captured",
    root: AbsolutePath.make(process.cwd()),
    provider: providerId,
    services: {
      [name]: {
        name,
        type: "node",
        provider: providerId,
        primary: true,
        environment: {},
        mounts: [],
        storage: [],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata,
        extensions: {},
      },
    },
    routes: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
  let loads = 0;
  let live: LandofileShape = {
    name: "captured",
    agentEnv: false,
    tooling: { probe: { service: "web", cmd: "echo {{ app.name }}" } },
  };
  let failure: LandofileParseError | undefined;
  let global = Schema.decodeUnknownSync(GlobalConfig)({});
  const calls: CommandSpec[] = [];
  const provider = {
    ...TestRuntimeProvider,
    execStream: (_target: ExecTarget, spec: CommandSpec) => {
      calls.push(spec);
      return Stream.make({ exitCode: 0 });
    },
  };
  const layer = Layer.mergeAll(
    testEnvironmentResolverLayer,
    PrivateFileAccessService.layer,
    ProviderExecToolingEngine.layer.pipe(Layer.provide(testEnvironmentResolverLayer)),
    Layer.succeed(
      LandofileService,
      LandofileService.of({
        discover: Effect.suspend(() => {
          loads++;
          return failure === undefined ? compileTestLandofile(live) : Effect.fail(failure);
        }),
      }),
    ),
    Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.succeed(plan) })),
    Layer.succeed(
      ConfigService,
      ConfigService.of({ load: Effect.sync(() => global), get: (key) => Effect.sync(() => global[key]) }),
    ),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        appliedPlansFor: () => Effect.succeed([]),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
        resolveAppliedPlan: () => Effect.succeed(undefined),
        list: Effect.succeed([providerId]),
        capabilities: Effect.succeed(provider.capabilities),
        select: () => Effect.succeed(provider),
      }),
    ),
  );
  const target: ResolvedAppTarget = {
    plan,
    root: plan.root,
    app: { kind: "user", id: plan.id, root: plan.root },
  };
  return {
    layer,
    target,
    calls,
    loads: () => loads,
    setLive: (value: LandofileShape) => {
      live = value;
    },
    setFailure: (value: LandofileParseError) => {
      failure = value;
    },
    setGlobal: (enabled: boolean) => {
      global = Schema.decodeUnknownSync(GlobalConfig)({ agentEnv: { enabled } });
    },
  };
};

const operations = {
  exec: (target?: ResolvedAppTarget) => execApp({ command: ["env"] }, target).pipe(Effect.asVoid),
  deep: (target?: ResolvedAppTarget) => infoApp({ deep: true }, target).pipe(Effect.asVoid),
  tooling: (target?: ResolvedAppTarget) => runTooling({ name: "probe" }, target).pipe(Effect.asVoid),
} as const;

test("direct tooling instantiates authored vars without activating copied data and normalizes env scalars", async () => {
  // Given
  const f = fixture();
  const landofile = await Effect.runPromise(
    compileTestLandofile({
      name: "captured",
      tooling: {
        probe: {
          service: "web",
          cmd: "{{ vars.copied }}",
          vars: { copied: "{{{{ event.CANARY }}", count: 17 },
          env: { COUNT: "{{ vars.count }}" },
        },
      },
    }),
  );
  // When
  await Effect.runPromise(
    runTooling({ name: "probe" }, { ...f.target, landofile }).pipe(Effect.provide(f.layer)),
  );
  // Then
  expect(f.calls[0]?.command[2]).toBe('{{ event.CANARY }} "$@"');
  expect(f.calls[0]?.env?.COUNT).toBe("17");
});

for (const [name, invoke] of Object.entries(operations)) {
  test(`${name} loads once for each plan-only or ordinary invocation and zero times with a snapshot`, async () => {
    const f = fixture();
    const captured = {
      ...f.target,
      landofile: await Effect.runPromise(
        compileTestLandofile({
          name: "captured",
          tooling: { probe: { service: "web", cmd: "echo {{ app.name }}" } },
        }),
      ),
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* invoke(captured);
        expect(f.loads()).toBe(0);
        yield* invoke(f.target);
        expect(f.loads()).toBe(1);
        yield* invoke();
        expect(f.loads()).toBe(2);
        f.setLive({
          name: "captured",
          agentEnv: true,
          tooling: { probe: { service: "web", cmd: "echo fresh" } },
        });
        yield* invoke();
        expect(f.loads()).toBe(3);
      }).pipe(Effect.provide(f.layer)),
    );
    if (name === "tooling") {
      expect(f.calls[0]?.command.join(" ")).toContain("echo captured");
      expect(f.calls[3]?.command.join(" ")).toContain("echo fresh");
    }
  });

  test(`${name} preserves the exact fallback-load failure`, async () => {
    const f = fixture();
    const error = new LandofileParseError({
      message: "bad authored input",
      filePath: "/captured/.lando.yml",
      line: undefined,
      column: undefined,
      remediation: "Correct the YAML syntax in /captured/.lando.yml.",
    });
    f.setFailure(error);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* invoke(f.target);
      }).pipe(Effect.result, Effect.provide(f.layer)),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure).toBe(error);
    expect(f.loads()).toBe(1);
    expect(f.calls).toEqual([]);
  });
}

test("supplied shallow info never loads, even when a fallback load would fail", async () => {
  const f = fixture();
  f.setFailure(
    new LandofileParseError({
      message: "bad",
      filePath: "/captured/.lando.yml",
      line: undefined,
      column: undefined,
      remediation: "Correct the YAML syntax in /captured/.lando.yml.",
    }),
  );
  const result = await Effect.runPromise(infoApp({}, f.target).pipe(Effect.provide(f.layer)));
  expect(result.agentEnv).toBeUndefined();
  expect(f.loads()).toBe(0);
});

test("captured operations still read invocation-time global and emergency controls", async () => {
  const f = fixture();
  const captured = {
    ...f.target,
    landofile: await Effect.runPromise(
      compileTestLandofile({ name: "captured", tooling: { probe: { service: "web", cmd: "env" } } }),
    ),
  };
  const saved = { claude: process.env.CLAUDECODE, veto: process.env.LANDO_AGENT_ENV };
  process.env.CLAUDECODE = "1";
  Reflect.deleteProperty(process.env, "LANDO_AGENT_ENV");
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* execApp({ command: ["env"] }, captured);
        expect(f.calls[0]?.env?.CLAUDECODE).toBe("1");
        f.setGlobal(false);
        yield* execApp({ command: ["env"], env: { CI: "explicit" } }, captured);
        expect(f.calls[1]?.env).toEqual({ CI: "explicit" });
        expect((yield* infoApp({ deep: true }, captured)).agentEnv?.enabled).toBe(false);
        f.setGlobal(true);
        process.env.LANDO_AGENT_ENV = "0";
        yield* runTooling({ name: "probe" }, captured);
        expect(f.calls[2]?.env?.CLAUDECODE).toBeUndefined();
        expect((yield* infoApp({ deep: true }, captured)).agentEnv?.enabled).toBe(false);
        expect(f.loads()).toBe(0);
      }).pipe(Effect.provide(f.layer)),
    );
  } finally {
    if (saved.claude === undefined) Reflect.deleteProperty(process.env, "CLAUDECODE");
    else process.env.CLAUDECODE = saved.claude;
    if (saved.veto === undefined) Reflect.deleteProperty(process.env, "LANDO_AGENT_ENV");
    else process.env.LANDO_AGENT_ENV = saved.veto;
  }
});
