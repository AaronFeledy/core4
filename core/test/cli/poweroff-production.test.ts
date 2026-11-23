import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCommandResult, taggedErrorJson } from "@lando/sdk/command-result";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  appIdentityKey,
} from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import type { AppliedOrphanGroup, ServiceRuntimeInfo } from "@lando/sdk/services";
import { DateTime, Effect } from "effect";
import { poweroffSpec } from "../../src/cli/command-specs/apps/poweroff";
import {
  PoweroffResultSchema,
  PoweroffStopError,
  poweroff,
  renderPoweroffResult,
} from "../../src/cli/commands/poweroff";
import { makePoweroffFixture } from "./poweroff-support";

const providerId = ProviderId.make("lando");

const planAt = (root: string): AppPlan => ({
  id: AppId.make("poweroff-app"),
  name: "poweroff-app",
  slug: "poweroff-app",
  root: AbsolutePath.make(root),
  identity: { appRoot: AbsolutePath.make(root), ownerKey: appIdentityKey("owner", root) },
  provider: providerId,
  services: {},
  routes: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.makeUnsafe("2026-08-01T00:00:00.000Z"),
    source: "applied-state",
    runtime: 4,
  },
  extensions: {},
});

const serviceAt = (root: string): ServiceRuntimeInfo => ({
  app: AppId.make("poweroff-app"),
  appRoot: AbsolutePath.make(root),
  service: ServiceName.make("web"),
  providerId,
  status: "running",
  containerId: "container-web",
  publications: { status: "unknown" },
  labels: { "dev.lando.data-root": root },
});

const orphanAt = (root: string): AppliedOrphanGroup => ({
  providerId,
  appId: AppId.make("poweroff-app"),
  services: [serviceAt(root)],
  volumes: [],
});

const withRoot = async <A>(use: (root: string) => Promise<A>): Promise<A> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-poweroff-production-")));
  await mkdir(join(root, "conf"), { recursive: true });
  await Bun.write(join(root, ".lando.yml"), "name: poweroff-app\n");
  try {
    return await use(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("stops orphaned containers of an app without applied state", async () => {
  await withRoot(async (root) => {
    // Given an app whose containers are running but whose applied record is gone.
    const fixture = await makePoweroffFixture({
      dataRoot: root,
      services: [serviceAt(root)],
      orphans: [orphanAt(root)],
    });
    // When the production command powers off.
    const result = await Effect.runPromise(poweroff().pipe(Effect.provide(fixture.layer)));
    // Then the stop lifecycle removes the orphan without a bare provider destroy.
    expect(result.apps).toEqual([
      {
        kind: "user",
        appId: "poweroff-app",
        appRoot: root,
        providerId: "lando",
        outcome: "stopped",
        servicesStopped: ["web"],
      },
      {
        kind: "global",
        appId: "global",
        appRoot: join(root, "global"),
        providerId: "lando",
        outcome: "unchanged",
        servicesStopped: [],
      },
    ]);
    expect(fixture.calls).toEqual(["remove:web", "runtime"]);
    expect(result.runtimeServiceStopped).toBe(true);
  });
});

test("aggregates a failed app and skips runtime shutdown", async () => {
  await withRoot(async (root) => {
    const fixture = await makePoweroffFixture({
      dataRoot: root,
      services: [serviceAt(root)],
      appliedPlans: [planAt(root)],
      destroyFailureRoot: root,
    });
    const result = await Effect.runPromise(poweroff().pipe(Effect.result, Effect.provide(fixture.layer)));
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("expected a typed poweroff failure");
    if (result.failure._tag !== "PoweroffStopError")
      throw new TypeError(`expected PoweroffStopError, received ${result.failure._tag}`);
    expect(result.failure).toMatchObject({
      _tag: "PoweroffStopError",
      failures: [
        {
          kind: "user",
          appId: "poweroff-app",
          appRoot: root,
          _tag: "ProviderUnavailableError",
        },
      ],
    });
    expect(result.failure.apps.find((app) => app.kind === "global")?.outcome).toBe("skipped");
    // The machine-output projection keeps each failed app as a nested tagged error.
    expect(taggedErrorJson(result.failure).failures).toMatchObject([
      {
        _tag: "ProviderUnavailableError",
        appId: "poweroff-app",
        appRoot: root,
        message: expect.stringContaining(`poweroff-app (${root}): `),
      },
    ]);
    expect(fixture.calls).not.toContain("runtime");
  });
});

const failedPostStop = {
  status: "failed",
  event: "post-stop",
  stepFailure: {
    _tag: "LandofileEventStepFailedError",
    message: "Cleanup script exited 7.",
    remediation: "Fix the cleanup script.",
  },
} as const;

test("renders stopped, unchanged, and failed-hook outcomes separately when app ids repeat", () => {
  const rendered = renderPoweroffResult({
    apps: [
      {
        kind: "user",
        appId: "twin",
        appRoot: "/one",
        providerId: "lando",
        outcome: "stopped",
        servicesStopped: [],
      },
      {
        kind: "user",
        appId: "twin",
        appRoot: "/two",
        providerId: "lando",
        outcome: "stopped",
        servicesStopped: [],
        landofileEvents: failedPostStop,
      },
      {
        kind: "user",
        appId: "twin",
        appRoot: "/quiet",
        providerId: "lando",
        outcome: "unchanged",
      },
    ],
    keptGlobalApp: false,
    keptScratchApps: 0,
    runtimeServiceStopped: true,
    runtimeServicePid: 1234,
  });
  const lines = rendered.split("\n");
  expect(
    lines.filter((line) => line.includes("twin (")).map((line) => line.match(/twin \(\/\w+\)/gu)),
  ).toEqual([["twin (/one)"], ["twin (/quiet)"], ["twin (/two)"]]);
  expect(lines.filter((line) => line.includes(failedPostStop.event))).toEqual([
    expect.stringContaining("twin (/two)"),
  ]);
  const diagnostic = lines.find((line) => line.includes(failedPostStop.event));
  expect(diagnostic).toContain(failedPostStop.stepFailure.message);
  expect(diagnostic).toContain(failedPostStop.stepFailure.remediation);
});

test("keeps an app with a failed hook off every success line", () => {
  const rendered = renderPoweroffResult({
    apps: [
      {
        kind: "user",
        appId: "idle",
        appRoot: "/idle",
        providerId: "lando",
        outcome: "unchanged",
        landofileEvents: failedPostStop,
      },
    ],
    keptGlobalApp: false,
    keptScratchApps: 0,
    runtimeServiceStopped: false,
  });
  const lines = rendered.split("\n");
  expect(lines.filter((line) => line.includes("idle"))).toEqual([
    expect.stringContaining(failedPostStop.event),
  ]);
});

test("encodes the failed hook on a stopped app even when another app fails to stop", async () => {
  const error = new PoweroffStopError({
    message: "Some apps could not stop.",
    remediation: "Restore provider access.",
    keptGlobalApp: false,
    keptScratchApps: 0,
    apps: [
      {
        kind: "user",
        appId: "stopped",
        appRoot: "/one",
        providerId: "lando",
        outcome: "stopped",
        landofileEvents: failedPostStop,
      },
      { kind: "user", appId: "blocked", appRoot: "/two", providerId: "lando", outcome: "skipped" },
    ],
    failures: [
      {
        kind: "user",
        appId: "blocked",
        appRoot: "/two",
        providerId: "lando",
        ...taggedErrorJson(new Error("Provider not reachable.")),
      },
    ],
  });
  const encoded = await Effect.runPromise(
    encodeCommandResult({
      command: poweroffSpec.id,
      resultSchema: PoweroffResultSchema,
      outcome: { _tag: "failure", error, additionalErrors: [] },
      redactor: createRedactor("secrets", { values: [] }),
    }),
  );

  expect(JSON.parse(encoded)).toMatchObject({
    ok: false,
    error: {
      _tag: "PoweroffStopError",
      apps: [{ appId: "stopped", landofileEvents: failedPostStop }, { appId: "blocked" }],
    },
  });
});

test("provides the scratch bootstrap tier through command metadata", () => {
  expect(poweroffSpec.bootstrap).toBe("scratch");
  expect(poweroffSpec.flags?.yes).toBeDefined();
});
