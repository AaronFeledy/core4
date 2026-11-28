import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type EngineIdentity,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import {
  EnvironmentValueResolver,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  ToolingEngine,
  type ToolingInvocation,
} from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { DateTime, Effect } from "effect";
import { executeToolingInvocations } from "../../src/operations/tooling-compile.ts";

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-11-28T00:00:00Z"),
  source: "tooling-engine-identity.test",
  runtime: 4 as const,
};
const root = AbsolutePath.make("/tmp/tooling-engine-identity");
const service: ServicePlan = {
  name: ServiceName.make("web"),
  type: "php:8.3",
  provider: ProviderId.make("podman"),
  primary: true,
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};
const plan: AppPlan = {
  valueModel: 1,
  id: AppId.make("tooling-engine-identity"),
  name: "tooling-engine-identity",
  slug: "tooling-engine-identity",
  root,
  identity: { appRoot: root, ownerKey: "owner" },
  provider: ProviderId.make("podman"),
  services: { [service.name]: service },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};
const engine = (host: string): EngineIdentity => ({
  fingerprint: host,
  endpoint: `unix:///${host}/podman.sock`,
});

const invocation: ToolingInvocation = {
  tool: "check",
  service: ServiceName.make("web"),
  commands: [["true"]],
};

const run = (input: {
  readonly recorded?: AppPlan & { readonly engineIdentity?: EngineIdentity | undefined };
  readonly current?: EngineIdentity | undefined;
  readonly suppliedProvider?: RuntimeProviderShape;
}) =>
  Effect.gen(function* () {
    const counts = { reads: 0, selects: 0 };
    const calls: string[] = [];
    const provider = new Proxy(
      {
        ...TestRuntimeProvider,
        id: "podman",
        ...(input.current === undefined ? {} : { engineIdentity: input.current }),
      },
      {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function"
            ? (...args: ReadonlyArray<unknown>) => {
                calls.push(String(property));
                return (value as (...inner: ReadonlyArray<unknown>) => unknown).apply(target, [...args]);
              }
            : value;
        },
      },
    );
    const registry = makeTestRuntimeProviderRegistry({
      readAppliedPlanStrict: () => {
        counts.reads += 1;
        return Effect.succeed(input.recorded);
      },
      select: () => {
        counts.selects += 1;
        return Effect.succeed(provider);
      },
    });
    const tooling = ToolingEngine.of({
      id: "test",
      run: () => Effect.succeed({ tool: "check", service: "web", exitCode: 0, stdout: "", stderr: "" }),
    });
    const outcome = yield* Effect.scoped(
      executeToolingInvocations({
        ...(input.suppliedProvider === undefined ? {} : { provider: input.suppliedProvider }),
        plan,
        tool: "check",
        invocations: [invocation],
        requiresProvider: true,
      }).pipe(
        Effect.provideService(RuntimeProviderRegistry, registry),
        Effect.provideService(ToolingEngine, tooling),
        Effect.provideService(
          EnvironmentValueResolver,
          EnvironmentValueResolver.of({
            openSession: () => Effect.succeed({ resolveEnvironment: () => Effect.succeed({}) }),
          }),
        ),
      ),
    ).pipe(Effect.result);
    return { outcome, counts, calls };
  });

test("tooling refuses a record from another engine without calling the provider", async () => {
  const { outcome, calls } = await Effect.runPromise(
    run({
      recorded: { ...plan, engineIdentity: engine("first") },
      current: engine("second"),
    }),
  );

  expect(outcome).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "AppPlacementError", desiredProviderId: "podman", realizedProviderId: "podman" },
  });
  if (outcome._tag === "Success") throw new Error("expected a refusal");
  expect(outcome.failure.message).toContain("unix:///first/podman.sock");
  expect(outcome.failure.message).toContain("unix:///second/podman.sock");
  expect(calls).toEqual([]);
});

test("tooling reads the applied record and selects the provider exactly once", async () => {
  const { outcome, counts, calls } = await Effect.runPromise(
    run({ recorded: { ...plan, engineIdentity: engine("first") }, current: engine("first") }),
  );

  expect(outcome._tag).toBe("Success");
  expect(counts).toEqual({ reads: 1, selects: 1 });
  expect(calls).toEqual([]);
});

test.each([
  ["no recorded plan", undefined, engine("second")],
  ["no provider identity", { ...plan, engineIdentity: undefined }, undefined],
  ["no recorded identity", { ...plan, engineIdentity: undefined }, engine("second")],
] as const)("tooling proceeds with %s", async (_label, recorded, current) => {
  const { outcome, counts } = await Effect.runPromise(
    run({
      ...(recorded === undefined ? {} : { recorded }),
      ...(current === undefined ? {} : { current }),
    }),
  );

  expect(outcome._tag).toBe("Success");
  expect(counts.reads).toBe(1);
});

test("a caller-supplied provider is admitted against the record too", async () => {
  const { outcome, counts } = await Effect.runPromise(
    run({
      recorded: { ...plan, engineIdentity: engine("first") },
      suppliedProvider: { ...TestRuntimeProvider, id: "podman", engineIdentity: engine("second") },
    }),
  );

  expect(outcome._tag).toBe("Failure");
  expect(counts.selects).toBe(0);
});
