import { describe, expect, test } from "bun:test";
import { type ServiceContainerChange, ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { byTag, makeHarness, plan, runStart, web } from "./start-progress-topology-support.ts";

const worker = { ...web, name: ServiceName.make("worker") };

const twoServicePlan = () => ({ ...plan, services: { ...plan.services, [worker.name]: worker } });

const target = (plannedApp = plan) => ({
  plan: plannedApp,
  root: plannedApp.root,
  app: { kind: "user" as const, id: plannedApp.id, root: plannedApp.root },
});

const outcome = (services: Readonly<Record<string, ServiceContainerChange>>) => () => ({
  changed: true,
  services,
});

const noticeBodies = (harness: ReturnType<typeof makeHarness>): ReadonlyArray<string> =>
  byTag(harness.events, "message.info")
    .map((event) => event.body)
    // Applied-state restarts have no Landofile in this harness and report the skipped hooks separately.
    .filter((body) => !body.startsWith("Skipping Landofile events for "));

describe("apply outcome notices", () => {
  test("an ordinary start announces a replacement and reports it in the result", async () => {
    // Given apply replaced the service container.
    const harness = makeHarness({
      applyOutcome: outcome({ web: { action: "replaced", reason: "config" } }),
    });
    // When the app starts.
    const result = await runStart(harness);
    // Then the replacement is announced and carried on the started service.
    expect(noticeBodies(harness)).toEqual([
      "Lando replaced web's container because its configuration changed.",
    ]);
    expect(result.servicesStarted[0]?.container).toEqual({ action: "replaced", reason: "config" });
  });

  test("a start replacement names the anonymous volumes that went with it", async () => {
    const harness = makeHarness({
      applyOutcome: outcome({
        web: { action: "replaced", reason: "publish-port", anonymousVolumes: ["/a", "/b"] },
      }),
    });
    await runStart(harness);
    expect(noticeBodies(harness)).toEqual([
      "Lando replaced web's container because its published ports changed. Its anonymous volumes at /a and /b went with it; declare those paths under storage: to keep their data.",
    ]);
  });

  test("an ordinary start does not announce a created container", async () => {
    const harness = makeHarness({ applyOutcome: outcome({ web: { action: "created" } }) });
    const result = await runStart(harness);
    expect(noticeBodies(harness)).toEqual([]);
    expect(result.servicesStarted[0]?.container).toEqual({ action: "created" });
  });

  test("an ordinary start announces nothing when the provider reports no outcome", async () => {
    const harness = makeHarness();
    const result = await runStart(harness);
    expect(noticeBodies(harness)).toEqual([]);
    expect(result.servicesStarted[0]?.container).toBeUndefined();
  });

  test("a bare restart announces nothing but reports what apply did", async () => {
    // Given apply replaced every container after the halt.
    const harness = makeHarness({
      applyOutcome: outcome({ web: { action: "replaced", reason: "reconcile" } }),
    });
    // When the whole app restarts.
    const result = await Effect.runPromise(restartApp({}, target()).pipe(Effect.provide(harness.layer)));
    // Then the designed recreation is not narrated, but the result still says what happened.
    expect(noticeBodies(harness)).toEqual([]);
    expect(result.servicesStarted[0]?.container).toEqual({ action: "replaced", reason: "reconcile" });
  });

  test("a whole-app rebuild announces nothing but reports what apply did", async () => {
    const harness = makeHarness({
      applyOutcome: outcome({ web: { action: "replaced", reason: "reconcile" } }),
    });
    const result = await Effect.runPromise(rebuildApp({}, target()).pipe(Effect.provide(harness.layer)));
    expect(noticeBodies(harness)).toEqual([]);
    expect(result.servicesStarted[0]?.container).toEqual({ action: "replaced", reason: "reconcile" });
  });

  test("a selected rebuild announces nothing but reports what apply did", async () => {
    const plannedApp = twoServicePlan();
    const harness = makeHarness({
      plannedApp,
      applyOutcome: outcome({ web: { action: "replaced", reason: "reconcile" } }),
    });
    const result = await Effect.runPromise(
      rebuildApp({ services: [web.name] }, target(plannedApp)).pipe(Effect.provide(harness.layer)),
    );
    expect(noticeBodies(harness)).toEqual([]);
    expect(result.servicesStarted.map((service) => service.name)).toEqual(["web"]);
    expect(result.servicesStarted[0]?.container).toEqual({ action: "replaced", reason: "reconcile" });
  });
});
