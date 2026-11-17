import { expect, test } from "bun:test";
import {
  AbsolutePath,
  type AppPlan,
  FileSyncSessionRef,
  PortablePath,
  ServiceName,
  type ServicePlan,
  plannedFileSyncSessions,
} from "@lando/sdk/schema";
import { TestFileSyncEngine } from "@lando/sdk/test";
import { DateTime, Effect } from "effect";

import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { withAcceleratedBind } from "../accelerated-plan.ts";
import { byTag, makeHarness, plan, web } from "./start-progress-topology-support.ts";

const scheduled = ServiceName.make("web-schedule");
const database = ServiceName.make("database");

const companion: ServicePlan = {
  ...web,
  name: scheduled,
  primary: false,
  command: ["/usr/local/bin/supercronic", "/usr/local/etc/supercronic/crontab"],
  endpoints: [],
  dependsOn: [{ service: web.name, condition: "service_started", required: true }],
  provenance: { clonedBy: { feature: "schedule.compile", from: String(web.name) } },
};

const databaseService: ServicePlan = {
  ...web,
  name: database,
  primary: false,
  command: ["postgres"],
  endpoints: [],
};

const plannedApp: AppPlan = {
  ...plan,
  services: { [web.name]: web, [scheduled]: companion, [database]: databaseService },
};

const target = {
  root: plannedApp.root,
  plan: plannedApp,
  app: { kind: "user", id: plannedApp.id, root: plannedApp.root } as const,
};

test("selected rebuild of a parent rebuilds its companion after it", async () => {
  // Given a companion cloned from web and an unrelated service.
  const applied: AppPlan[] = [];
  const stopped: ServiceName[] = [];
  const harness = makeHarness({
    plannedApp,
    onApply: (appliedPlan) => {
      applied.push(appliedPlan);
    },
    onStop: (stopTarget) => {
      stopped.push(stopTarget.service);
    },
  });

  // When only the parent is requested.
  const result = await Effect.runPromise(
    rebuildApp({ services: [web.name] }, target).pipe(Effect.provide(harness.layer)),
  );

  // Then the companion is rebuilt with it, in dependency order, and nothing else is.
  expect(stopped).toEqual([scheduled, web.name]);
  expect(Object.keys(applied[0]?.services ?? {})).toEqual([web.name, scheduled]);
  expect(result.servicesRebuilt).toEqual([web.name, scheduled]);
});

test("selected rebuild of a service without companions is unchanged", async () => {
  // Given a plan whose companion belongs to a different parent.
  const applied: AppPlan[] = [];
  const harness = makeHarness({
    plannedApp,
    onApply: (appliedPlan) => {
      applied.push(appliedPlan);
    },
  });

  // When the unrelated service is requested.
  const result = await Effect.runPromise(
    rebuildApp({ services: [database] }, target).pipe(Effect.provide(harness.layer)),
  );

  // Then only it is rebuilt.
  expect(Object.keys(applied[0]?.services ?? {})).toEqual([database]);
  expect(result.servicesRebuilt).toEqual([database]);
});

test("selected restart of a parent selects exactly the named service", async () => {
  // Given the same plan and every container already running.
  const applied: AppPlan[] = [];
  const stopped: ServiceName[] = [];
  const harness = makeHarness({
    plannedApp,
    onApply: (appliedPlan) => {
      applied.push(appliedPlan);
    },
    onStop: (stopTarget) => {
      stopped.push(stopTarget.service);
    },
    inspect: (inspectTarget) =>
      Effect.succeed({
        app: plannedApp.id,
        service: inspectTarget.service,
        providerId: plannedApp.provider,
        status: "running" as const,
        containerId: `cid-${String(inspectTarget.service)}`,
        publications: { status: "present" as const, bindings: [] },
      }),
  });

  // When the parent is restarted.
  const result = await Effect.runPromise(
    restartApp({ services: [web.name] }, target).pipe(Effect.provide(harness.layer)),
  );

  // Then its companion stays untouched.
  expect(stopped).toEqual([web.name]);
  expect(Object.keys(applied[0]?.services ?? {})).toEqual([web.name]);
  expect(result.servicesStarted.map((service) => service.name)).toEqual([web.name]);
});

test("selected rebuild refreshes the artifact before stopping, forces the app build, and flushes retained file sync", async () => {
  // Given a companion plan with an accelerated bind the applied record already covers.
  const accelerated = {
    ...plannedApp,
    services: {
      ...plannedApp.services,
      [web.name]: {
        ...web,
        mounts: [
          {
            type: "bind" as const,
            source: plan.root,
            target: PortablePath.make("/app"),
            readOnly: false,
            realization: "accelerated" as const,
            mountKey: "app-mount",
            excludes: [],
          },
        ],
      },
    },
  };
  const withSessions: AppPlan = {
    ...accelerated,
    fileSync:
      plannedFileSyncSessions(accelerated)?.map((session) => ({
        engineId: "mutagen",
        session: {
          app: { kind: "user", id: accelerated.id, root: accelerated.root },
          service: ServiceName.make(session.service),
          mountKey: session.mountKey,
          source: AbsolutePath.make(session.source),
          target: { _tag: "volume", name: session.volumeName, path: session.targetPath },
          mode: "two-way-safe",
          excludes: session.excludes,
        },
      })) ?? [],
  };
  const calls: string[] = [];
  const flushed: FileSyncSessionRef[] = [];
  const builds: Array<{ readonly refresh?: boolean }> = [];
  const appBuilds: Array<{ readonly force?: boolean }> = [];
  const harness = makeHarness({
    plannedApp: withSessions,
    appliedFileSyncState: "accelerated",
    onBuild: (_plan, options) => {
      calls.push("build");
      builds.push({ ...(options?.refresh === undefined ? {} : { refresh: options.refresh }) });
    },
    onStop: () => {
      calls.push("stop");
    },
    onBuildApp: (_plan, options) => {
      calls.push("app-build");
      appBuilds.push({ ...(options?.force === undefined ? {} : { force: options.force }) });
    },
    fileSync: {
      ...TestFileSyncEngine,
      id: "mutagen",
      sessionsPersistAcrossProcesses: true,
      isAvailable: Effect.succeed(true),
      listSessions: () =>
        Effect.succeed(
          withSessions.fileSync.map(({ session }) => ({
            ref: FileSyncSessionRef.make(`sess-${session.service}`),
            app: session.app,
            service: session.service,
            mountKey: session.mountKey,
            spec: session,
            status: "running" as const,
            lastUpdatedAt: DateTime.makeUnsafe("2026-05-28T00:00:00Z"),
          })),
        ),
      flushSession: (ref) => {
        calls.push("file-sync");
        flushed.push(ref);
        return Effect.void;
      },
    },
    onApply: () => {
      calls.push("apply");
    },
  });

  // When the parent plus its companion are rebuilt.
  await Effect.runPromise(
    rebuildApp({ services: [web.name] }, { ...target, plan: withSessions }).pipe(
      Effect.provide(harness.layer),
    ),
  );

  // Then the refresh build precedes stopping, both services publish stop events, and the retained sync is flushed.
  expect(builds).toEqual([{ refresh: true }]);
  expect(calls.indexOf("build")).toBeLessThan(calls.indexOf("stop"));
  expect(flushed).toEqual([FileSyncSessionRef.make("sess-web")]);
  expect(appBuilds).toEqual([{ force: true }]);
  expect(byTag(harness.events, "pre-service-stop").map((event) => event.serviceName)).toEqual([
    scheduled,
    web.name,
  ]);
  expect(byTag(harness.events, "post-service-stop").map((event) => event.serviceName)).toEqual([
    scheduled,
    web.name,
  ]);
});

test("selected rebuild refuses a new accelerated session before stopping", async () => {
  // Given a selected accelerated bind the applied record never prepared.
  const accelerated = withAcceleratedBind(plannedApp, web.name, {
    type: "bind",
    source: plan.root,
    target: PortablePath.make("/app"),
    readOnly: false,
    realization: "accelerated",
    mountKey: "app-mount",
    excludes: [],
  });
  const applied: AppPlan = { ...accelerated, fileSync: [], services: plannedApp.services };
  const stopped: string[] = [];
  const harness = makeHarness({
    plannedApp: accelerated,
    appliedPlans: [applied],
    resolveAppliedPlan: () => Effect.succeed(applied),
    fileSync: {
      ...TestFileSyncEngine,
      id: "mutagen",
      isAvailable: Effect.succeed(true),
      listSessions: () => Effect.succeed([]),
    },
    onStop: () => {
      stopped.push("stop");
    },
  });

  // When the selected rebuild preflights the accelerated bundle.
  const error = await Effect.runPromise(
    Effect.flip(
      rebuildApp({ services: [web.name] }, { ...target, plan: accelerated }).pipe(
        Effect.provide(harness.layer),
      ),
    ),
  );

  // Then it refuses before any stop with the start remediation.
  expect(error).toMatchObject({ _tag: "FileSyncStartError" });
  expect(error.message).toContain("web");
  expect(error.remediation).toContain("lando start");
  expect(stopped).toEqual([]);
});
