import { expect, test } from "bun:test";
import { type AppPlan, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { Effect } from "effect";

import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

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
