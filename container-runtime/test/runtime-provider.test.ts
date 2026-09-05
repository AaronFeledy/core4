import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Exit, Stream } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";

import type { ProviderDataPlane } from "../src/data-plane.ts";
import { type ResolvedProviderOpsInput, makeResolvedProviderOps } from "../src/runtime-provider.ts";

const app = AppId.make("app");
const service = ServiceName.make("web");
const target = { app, service };
const command = { command: ["true"] };
const plan = {
  id: app,
  name: "App",
  slug: "app",
  root: AbsolutePath.make("/tmp/app"),
  provider: ProviderId.make("test"),
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: { resolvedAt: DateTime.unsafeMake("2026-09-06T00:00:00Z"), source: "test", runtime: 4 },
  extensions: {},
} satisfies AppPlan;
const ctx = { providerId: "test", remediation: "Run doctor." } as const;

const noPlanError = (missingApp: AppId, operation: string) =>
  new ProviderUnavailableError({
    providerId: ctx.providerId,
    operation,
    message: `No applied plan is available for app ${missingApp}.`,
    remediation: ctx.remediation,
  });

interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
}

const makeService = (calls: Call[]): ResolvedProviderOpsInput["service"] => ({
  lifecycle: (resolvedPlan, selector, action) => {
    calls.push({ name: "lifecycle", args: [resolvedPlan, selector, action] });
    return Effect.void;
  },
  waitForExit: (resolvedPlan, selector, options) => {
    calls.push({ name: "waitForExit", args: [resolvedPlan, selector, options] });
    return Effect.succeed({ exitCode: 7 });
  },
  exec: (resolvedPlan, selector, spec) => {
    calls.push({ name: "exec", args: [resolvedPlan, selector, spec] });
    return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
  },
  execStream: (resolvedPlan, selector, spec) => {
    calls.push({ name: "execStream", args: [resolvedPlan, selector, spec] });
    return Stream.make({ exitCode: 0 });
  },
  inspect: (resolvedPlan, selector) => {
    calls.push({ name: "inspect", args: [resolvedPlan, selector] });
    return Effect.succeed({ app, service, providerId: ProviderId.make("test"), status: "running" });
  },
});

const makeDataPlane = (calls: Call[]): ProviderDataPlane => ({
  run: (spec) => {
    calls.push({ name: "run", args: [spec] });
    return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
  },
  runStream: (spec) => {
    calls.push({ name: "runStream", args: [spec] });
    return Stream.make({ exitCode: 0 });
  },
  snapshotVolume: (spec) => {
    calls.push({ name: "snapshotVolume", args: [spec] });
    return Effect.succeed({ provider: ProviderId.make("test"), id: "snap" });
  },
  restoreVolume: (spec) => {
    calls.push({ name: "restoreVolume", args: [spec] });
    return Effect.void;
  },
  listVolumes: (filter) => {
    calls.push({ name: "listVolumes", args: [filter] });
    return Effect.succeed([]);
  },
  removeVolume: (ref) => {
    calls.push({ name: "removeVolume", args: [ref] });
    return Effect.void;
  },
  copyToService: (selector, spec) => {
    calls.push({ name: "copyToService", args: [selector, spec] });
    return Effect.void;
  },
  copyFromService: (selector, spec) => {
    calls.push({ name: "copyFromService", args: [selector, spec] });
    return Stream.make(new Uint8Array([1]));
  },
  exportArtifact: (ref) => {
    calls.push({ name: "exportArtifact", args: [ref] });
    return Stream.make(new Uint8Array([2]));
  },
  importArtifact: (data) => {
    calls.push({ name: "importArtifact", args: [data] });
    return Effect.succeed({ providerId: ProviderId.make("test"), ref: "image" });
  },
});

const makeInput = (
  calls: Call[],
  resolvePlan: ResolvedProviderOpsInput["resolvePlan"] = () => Effect.succeed(plan),
  includeDataPlane = true,
): ResolvedProviderOpsInput => {
  const dataPlane = includeDataPlane ? makeDataPlane(calls) : undefined;
  return {
    ctx,
    resolvePlan,
    noPlanError,
    before: Effect.sync(() => calls.push({ name: "before", args: [] })),
    service: makeService(calls),
    ...(dataPlane === undefined ? {} : { dataPlane }),
  };
};

describe("resolved provider operations", () => {
  test("resolves plans before before-effects and service delegation", async () => {
    // Given
    const calls: Call[] = [];
    const input = makeInput(calls, () =>
      Effect.sync(() => {
        calls.push({ name: "resolve", args: [] });
        return plan;
      }),
    );
    const ops = makeResolvedProviderOps(input);
    const options = { signal: new AbortController().signal };

    // When
    await Effect.runPromise(ops.start(target));
    await Effect.runPromise(ops.stop(target));
    await Effect.runPromise(ops.restart(target));
    await Effect.runPromise(Effect.scoped(ops.waitForExit(target, options)));
    await Effect.runPromise(ops.exec(target, command));
    await Effect.runPromise(Effect.scoped(ops.execStream(target, command).pipe(Stream.runDrain)));
    await Effect.runPromise(ops.inspect(target));

    // Then
    expect(calls).toEqual([
      { name: "resolve", args: [] },
      { name: "before", args: [] },
      { name: "lifecycle", args: [plan, target, "start"] },
      { name: "resolve", args: [] },
      { name: "before", args: [] },
      { name: "lifecycle", args: [plan, target, "stop"] },
      { name: "resolve", args: [] },
      { name: "before", args: [] },
      { name: "lifecycle", args: [plan, target, "restart"] },
      { name: "resolve", args: [] },
      { name: "before", args: [] },
      { name: "waitForExit", args: [plan, target, options] },
      { name: "resolve", args: [] },
      { name: "before", args: [] },
      { name: "exec", args: [plan, target, command] },
      { name: "resolve", args: [] },
      { name: "before", args: [] },
      { name: "execStream", args: [plan, target, command] },
      { name: "resolve", args: [] },
      { name: "before", args: [] },
      { name: "inspect", args: [plan, target] },
    ]);
  });

  test("does not run before or delegate when a plan is missing", async () => {
    // Given
    const calls: Call[] = [];
    const ops = makeResolvedProviderOps(makeInput(calls, () => Effect.succeed(undefined)));

    // When
    const exit = await Effect.runPromiseExit(ops.start(target));

    // Then
    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls).toEqual([]);
    if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") throw new Error("Expected no-plan failure");
    expect(exit.cause.error).toEqual(noPlanError(app, "start"));
  });

  test("runs before and delegates all ten data-plane members with their arguments", async () => {
    // Given
    const calls: Call[] = [];
    const ops = makeResolvedProviderOps(makeInput(calls));
    const runSpec = { image: "alpine", command: ["true"] };
    const volume = { app, store: "data" };
    const snapshotSpec = { volume, snapshotId: "snap" };
    const restoreSpec = { snapshot: { provider: ProviderId.make("test"), id: "snap" }, target: volume };
    const copyIn = { sourcePath: AbsolutePath.make("/tmp/in"), targetPath: PortablePath.make("/tmp/out") };
    const copyOut = { sourcePath: PortablePath.make("/tmp/out") };
    const artifact = { providerId: ProviderId.make("test"), ref: "image" };
    const data = Stream.make(new Uint8Array([3]));

    // When
    await Effect.runPromise(Effect.scoped(ops.run(runSpec)));
    await Effect.runPromise(Effect.scoped(ops.runStream(runSpec).pipe(Stream.runDrain)));
    await Effect.runPromise(Effect.scoped(ops.snapshotVolume(snapshotSpec)));
    await Effect.runPromise(Effect.scoped(ops.restoreVolume(restoreSpec)));
    await Effect.runPromise(ops.listVolumes({ app }));
    await Effect.runPromise(ops.removeVolume(volume));
    await Effect.runPromise(Effect.scoped(ops.copyToService(target, copyIn)));
    await Effect.runPromise(Effect.scoped(ops.copyFromService(target, copyOut).pipe(Stream.runDrain)));
    await Effect.runPromise(Effect.scoped(ops.exportArtifact(artifact).pipe(Stream.runDrain)));
    await Effect.runPromise(Effect.scoped(ops.importArtifact(data)));

    // Then
    expect(calls.filter(({ name }) => name === "before")).toHaveLength(10);
    expect(calls.filter(({ name }) => name !== "before").map(({ name }) => name)).toEqual([
      "run",
      "runStream",
      "snapshotVolume",
      "restoreVolume",
      "listVolumes",
      "removeVolume",
      "copyToService",
      "copyFromService",
      "exportArtifact",
      "importArtifact",
    ]);
    const copyCalls = calls.filter(({ name }) => name === "copyToService" || name === "copyFromService");
    expect(copyCalls.map(({ args }) => args[0])).toEqual([
      { ...target, plan },
      { ...target, plan },
    ]);
  });

  test("fails every data-plane member as unavailable when no data plane exists", async () => {
    // Given
    const ops = makeResolvedProviderOps(makeInput([], undefined, false));
    const volume = { app, store: "data" };
    const failures = [
      Effect.scoped(ops.run({ image: "alpine", command: ["true"] })),
      Effect.scoped(ops.runStream({ image: "alpine", command: ["true"] }).pipe(Stream.runDrain)),
      Effect.scoped(ops.snapshotVolume({ volume })),
      Effect.scoped(
        ops.restoreVolume({ snapshot: { provider: ProviderId.make("test"), id: "x" }, target: volume }),
      ),
      ops.listVolumes({ app }),
      ops.removeVolume(volume),
      Effect.scoped(
        ops.copyToService(target, {
          sourcePath: AbsolutePath.make("/tmp/in"),
          targetPath: PortablePath.make("/tmp/out"),
        }),
      ),
      Effect.scoped(
        ops.copyFromService(target, { sourcePath: PortablePath.make("/tmp/out") }).pipe(Stream.runDrain),
      ),
      Effect.scoped(
        ops.exportArtifact({ providerId: ProviderId.make("test"), ref: "image" }).pipe(Stream.runDrain),
      ),
      Effect.scoped(ops.importArtifact(Stream.empty)),
    ];

    // When
    const exits = await Promise.all(failures.map((failure) => Effect.runPromiseExit(failure)));

    // Then
    expect(exits).toHaveLength(10);
    for (const exit of exits) {
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail")
        throw new Error("Expected unavailable failure");
      expect(exit.cause.error).toBeInstanceOf(ProviderUnavailableError);
      expect(exit.cause.error.providerId).toBe(ctx.providerId);
    }
  });
});
