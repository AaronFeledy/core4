import { describe, expect, test } from "bun:test";
import { ScratchAppNotFoundError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
  appIdentityKey,
} from "@lando/sdk/schema";
import { RuntimeProviderRegistry, ScratchAppService, type ScratchHandle } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { type Context, DateTime, Effect, Layer, Stream } from "effect";
import { followScratchLogs, scratchLogs } from "../../src/cli/commands/scratch.ts";

const root = AbsolutePath.make("/tmp/lando-scratch-logs-app");
const scratchId = "scratch-demo-abc123";
const providerId = ProviderId.make("test");

const handle: ScratchHandle = {
  id: scratchId,
  app: { kind: "scratch", id: AppId.make(scratchId), root },
};

const serviceAt = (name: string): ServicePlan => ({
  name: ServiceName.make(name),
  type: "lando",
  provider: providerId,
  primary: name === "web",
  artifact: { kind: "ref", ref: `${name}:test` },
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: {
    resolvedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
    source: "applied-state",
    runtime: 4,
  },
  extensions: {},
});

const appliedPlan = (): AppPlan => ({
  id: AppId.make(scratchId),
  name: scratchId,
  slug: scratchId,
  root,
  identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) },
  provider: providerId,
  services: {
    [ServiceName.make("web")]: serviceAt("web"),
    [ServiceName.make("db")]: serviceAt("db"),
  },
  routes: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
    source: "applied-state",
    runtime: 4,
  },
  extensions: {},
});

type ResolveById = Context.Service.Shape<typeof ScratchAppService>["resolveById"];

const scratchService = (resolve: ResolveById) =>
  ScratchAppService.of({
    kind: "scratch",
    root: Effect.succeed(root),
    ensureRoot: Effect.die("unexpected ensureRoot"),
    synthesizeId: () => Effect.die("unexpected synthesizeId"),
    paths: () => Effect.die("unexpected paths"),
    acquire: () => Effect.die("unexpected acquire"),
    resolveById: resolve,
    info: () => Effect.die("unexpected info"),
    list: () => Effect.die("unexpected list"),
    start: () => Effect.die("unexpected start"),
    stop: () => Effect.die("unexpected stop"),
    destroy: () => Effect.die("unexpected destroy"),
    gc: () => Effect.die("unexpected gc"),
  });

interface LogCall {
  readonly service: string;
  readonly follow: boolean;
  readonly tail?: number;
  readonly since?: string;
}

const harness = (input: { readonly plan?: AppPlan; readonly failing?: boolean }) => {
  const calls: LogCall[] = [];
  const resolutions: Array<unknown> = [];
  const provider = {
    ...TestRuntimeProvider,
    id: providerId,
    capabilities: { ...TestRuntimeProvider.capabilities, serviceLogs: true },
    logs: (
      target: { readonly service: ServiceName },
      options: { readonly follow: boolean; readonly tail?: number; readonly since?: string },
    ) => {
      calls.push({
        service: String(target.service),
        follow: options.follow,
        ...(options.tail === undefined ? {} : { tail: options.tail }),
        ...(options.since === undefined ? {} : { since: options.since }),
      });
      return Stream.fromIterable([
        { service: target.service, stream: "stdout" as const, line: `${String(target.service)} line` },
      ]);
    },
  };
  const registry = RuntimeProviderRegistry.of({
    resolveAppliedPlan: (lookupRoot, app, lookup) =>
      Effect.sync(() => {
        resolutions.push({ root: lookupRoot, app, lookup });
        return input.plan;
      }),
    select: () => Effect.succeed(provider),
    appliedPlansFor: () => Effect.succeed([]),
    list: Effect.succeed([]),
    capabilities: Effect.die("unexpected capabilities"),
    resolveTeardownEvidence: () => Effect.die("unexpected teardown resolution"),
  });
  const layer = Layer.merge(
    Layer.succeed(
      ScratchAppService,
      scratchService(
        input.failing === true
          ? () =>
              Effect.fail(
                new ScratchAppNotFoundError({
                  id: scratchId,
                  message: `Scratch app ${scratchId} does not exist.`,
                  suggestions: [],
                  remediation: "Run `lando scratch:list` and pass an existing scratch id.",
                }),
              )
          : () => Effect.succeed(handle),
      ),
    ),
    Layer.succeed(RuntimeProviderRegistry, registry),
  );
  return { calls, resolutions, layer };
};

type Harness = ReturnType<typeof harness>;

type HarnessServices = ScratchAppService | RuntimeProviderRegistry;

const run = <A, E>(current: Harness, effect: Effect.Effect<A, E, HarnessServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(current.layer)));

const failure = <A, E>(current: Harness, effect: Effect.Effect<A, E, HarnessServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(current.layer), Effect.flip));

describe("scratch:logs", () => {
  test("resolves the applied plan by exact scratch identity and forwards log flags", async () => {
    const current = harness({ plan: appliedPlan() });
    const result = await run(current, scratchLogs(scratchId, { service: "db", tail: 5, since: "15m" }));

    expect(current.resolutions).toEqual([{ root, app: { kind: "scratch", id: scratchId }, lookup: "exact" }]);
    expect(current.calls).toHaveLength(1);
    expect(current.calls[0]).toMatchObject({ service: "db", follow: false, tail: 5 });
    expect(current.calls[0]?.since).toMatch(/^\d+$/u);
    expect(result.app).toBe(scratchId);
    expect(result.lines).toEqual([{ service: "db", stream: "stdout", line: "db line" }]);
  });

  test("reads every service without a filter", async () => {
    const current = harness({ plan: appliedPlan() });
    const result = await run(current, scratchLogs(scratchId));

    expect(current.calls.map((call) => call.service).sort()).toEqual(["db", "web"]);
    expect(result.lines?.map((line) => line.line).sort()).toEqual(["db line", "web line"]);
  });

  test("follow passes follow mode to the provider", async () => {
    const current = harness({ plan: appliedPlan() });
    const result = await run(current, followScratchLogs(scratchId, { service: "web", follow: true }));

    expect(current.calls).toEqual([{ service: "web", follow: true }]);
    expect(result.lines).toEqual([{ service: "web", stream: "stdout", line: "web line" }]);
  });

  test("an absent applied plan validates --since and returns no lines", async () => {
    const current = harness({});
    expect(await run(current, scratchLogs(scratchId, { since: "2h" }))).toEqual({
      app: scratchId,
      lines: [],
    });
    expect(current.calls).toEqual([]);
    expect((await failure(current, scratchLogs(scratchId, { since: "not-a-duration" })))._tag).toBe(
      "ToolingExecError",
    );
  });

  test("an unknown scratch id fails before any applied-plan lookup", async () => {
    const current = harness({ failing: true });
    expect((await failure(current, scratchLogs(scratchId)))._tag).toBe("ScratchAppNotFoundError");
    expect(current.resolutions).toEqual([]);
  });
});
