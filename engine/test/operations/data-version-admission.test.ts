import { expect, test } from "bun:test";
import { ServiceExecError } from "@lando/sdk/errors";
import type { CommandSpec, ExecTarget } from "@lando/sdk/services";
import { Effect } from "effect";
import { withAppActivation } from "../../src/operations/app-activation.ts";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { startApp } from "../../src/operations/start.ts";
import { databaseRuntime, versionedPlan } from "./data-version-support.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

const target = (desired: typeof plan) => ({
  app: { kind: "user" as const, id: desired.id, root: desired.root },
  root: desired.root,
  plan: desired,
});

const setup = (input: {
  readonly from: string;
  readonly to: string;
  readonly evidence: "record" | "running-image" | "stopped" | "exec-failure" | "oversized" | "no-record";
  readonly upgrade?: "in-place" | "unsupported";
}) => {
  const previous = versionedPlan(plan, web, input.from);
  const desired = versionedPlan(plan, web, input.to, input.upgrade);
  const observations: string[] = [];
  const mutations: string[] = [];
  const timeline: ({ readonly kind: "notice"; readonly body: string } | { readonly kind: "apply" })[] = [];
  const exec = (t: ExecTarget, cmd: CommandSpec) => {
    if (
      t.expectedContainerId !== "database-original" ||
      !cmd.command.includes("/var/lib/mysql/mariadb_upgrade_info")
    )
      return Effect.die("Unpinned version read or wrong record path");
    observations.push("read");
    if (input.evidence === "exec-failure")
      return Effect.fail(
        new ServiceExecError({
          providerId: plan.provider,
          service: web.name,
          operation: "exec",
          message: "Container is gone",
          remediation: "Observe the current container.",
        }),
      );
    const stdout =
      input.evidence === "running-image" || input.evidence === "no-record"
        ? "\0"
        : `${input.from}.13-MariaDB\n${input.evidence === "oversized" ? "x".repeat(4096) : ""}\0`;
    return Effect.succeed({ exitCode: 0, stdout, stderr: "" });
  };
  const harness = makeHarness({
    plannedApp: desired,
    appliedPlans: [previous],
    inspect: (t) =>
      Effect.sync(() => {
        const runtime = databaseRuntime(previous, t.service);
        if (t.plan === undefined) return runtime;
        observations.push("inspect");
        if (input.evidence === "stopped") return { ...runtime, status: "exited", exitCode: 0 } as const;
        if (input.evidence === "running-image") return { ...runtime, health: "healthy" } as const;
        return runtime;
      }),
    exec,
    onPublish: (event) =>
      Effect.sync(() => {
        if (event._tag === "message.info") timeline.push({ kind: "notice", body: event.body });
      }),
    onApply: () => {
      mutations.push("apply");
      timeline.push({ kind: "apply" });
    },
    onStop: () => {
      mutations.push("stop");
    },
    onDestroy: () => {
      mutations.push("destroy");
    },
  });
  return { ...harness, target: target(desired), observations, mutations, timeline };
};

test("warm start adds no data version provider calls", async () => {
  const fixture = setup({ from: "11.4", to: "11.4", evidence: "record" });
  const result = await Effect.runPromise(startApp({}, fixture.target).pipe(Effect.provide(fixture.layer)));
  expect(fixture.observations).toEqual([]);
  expect(result.dataVersionChanges).toBeUndefined();
});

test.each(["start", "selected restart", "rebuild"] as const)(
  "%s refuses a downgrade before stopping or applying",
  async (operation) => {
    const fixture = setup({ from: "11.4", to: "10.11", evidence: "record" });
    const effect =
      operation === "start"
        ? startApp({}, fixture.target)
        : operation === "selected restart"
          ? restartApp({ services: [web.name] }, fixture.target)
          : rebuildApp({}, fixture.target);
    const error = await Effect.runPromise(Effect.flip(effect.pipe(Effect.provide(fixture.layer))));
    expect(error).toMatchObject({
      _tag: "ServiceDataVersionError",
      image: "mariadb:10.11",
      appliedImage: "mariadb:11.4",
      dataVersion: { direction: "downgrade", evidence: "record", dataVersion: "11.4", imageVersion: "10.11" },
    });
    expect(fixture.observations).toEqual(["inspect", "read"]);
    expect(fixture.mutations).toEqual([]);
  },
);

test("a healthy running server supplies version evidence when the record is absent", async () => {
  const fixture = setup({ from: "11.4", to: "10.11", evidence: "running-image" });
  const error = await Effect.runPromise(
    Effect.flip(startApp({}, fixture.target).pipe(Effect.provide(fixture.layer))),
  );
  expect(error).toMatchObject({
    _tag: "ServiceDataVersionError",
    dataVersion: {
      direction: "downgrade",
      evidence: "running-image",
      dataVersion: "11.4",
      imageVersion: "10.11",
    },
  });
});

test("an unsupported upgrade refuses even though the old version is lower", async () => {
  const fixture = setup({ from: "10.11", to: "11.4", evidence: "record", upgrade: "unsupported" });
  const error = await Effect.runPromise(
    Effect.flip(startApp({}, fixture.target).pipe(Effect.provide(fixture.layer))),
  );
  expect(error).toMatchObject({ _tag: "ServiceDataVersionError", dataVersion: { direction: "upgrade" } });
  expect(fixture.mutations).toEqual([]);
});

test.each(["stopped", "no-record", "exec-failure", "oversized"] as const)(
  "a %s prior server does not establish a downgrade",
  async (evidence) => {
    const fixture = setup({ from: "11.4", to: "10.11", evidence });
    const result = await Effect.runPromise(startApp({}, fixture.target).pipe(Effect.provide(fixture.layer)));
    expect(result.dataVersionChanges).toBeUndefined();
    expect(fixture.mutations).toEqual(["apply"]);
    expect(fixture.observations).toEqual(evidence === "stopped" ? ["inspect"] : ["inspect", "read"]);
  },
);

test.each([
  ["stopped", "applied-plan", ["inspect"]],
  ["no-record", "applied-plan", ["inspect", "read"]],
  ["record", "record", ["inspect", "read"]],
  ["running-image", "running-image", ["inspect", "read"]],
] as const)("admits an in-place upgrade with %s evidence", async (evidence, source, observations) => {
  const fixture = setup({ from: "10.11", to: "11.4", evidence });
  const upgrades = await Effect.runPromise(
    withAppActivation(
      {
        operation: "start",
        target: fixture.target,
        services: undefined,
        signal: undefined,
        managed: undefined,
      },
      ({ dataUpgrades }) => Effect.succeed(dataUpgrades),
    ).pipe(Effect.provide(fixture.layer)),
  );
  expect(upgrades).toMatchObject([{ service: "web", from: "10.11", to: "11.4", source }]);
  expect(fixture.observations).toEqual([...observations]);
});

test("an older applied series alone does not refuse an unsupported upgrade", async () => {
  const fixture = setup({ from: "10.11", to: "11.4", evidence: "stopped", upgrade: "unsupported" });
  const result = await Effect.runPromise(startApp({}, fixture.target).pipe(Effect.provide(fixture.layer)));
  expect(result.dataVersionChanges).toBeUndefined();
  expect(fixture.mutations).toEqual(["apply"]);
});

test("reports an in-place upgrade before applying", async () => {
  const fixture = setup({ from: "10.11", to: "11.4", evidence: "record" });
  const result = await Effect.runPromise(startApp({}, fixture.target).pipe(Effect.provide(fixture.layer)));
  expect(result.dataVersionChanges).toEqual([{ service: "web", from: "10.11", to: "11.4" }]);
  const firstApply = fixture.timeline.findIndex(({ kind }) => kind === "apply");
  expect(fixture.timeline[firstApply]).toEqual({ kind: "apply" });
  expect(fixture.timeline.slice(0, firstApply)).toContainEqual({
    kind: "notice",
    body: expect.stringMatching(/\bweb\b.*\bMariaDB\b.*\b10\.11\b.*\b11\.4\b/su),
  });
});
