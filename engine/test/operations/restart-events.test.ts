import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { LandofileEventStepFailedError } from "@lando/sdk/errors";
import { RouterService, ToolingEngine } from "@lando/sdk/services";
import { TestRouterService } from "@lando/sdk/test";
import { restartApp } from "../../src/operations/restart.ts";
import { attachEffectiveEvents } from "../../src/planner/effective-events.ts";
import { byTag, makeHarness, plan } from "./start-progress-topology-support.ts";

const restartHarness = (failure?: string) => {
  const executed: string[] = [];
  const routeRemovals: string[] = [];
  const plannedApp = attachEffectiveEvents(plan, {
    "pre-init": ["{{ event._tag }}"],
    "post-init": ["{{ event._tag }}"],
    "pre-restart": ["{{ event._tag }}"],
    "pre-stop": ["{{ event._tag }}"],
    "post-stop": ["{{ event._tag }}"],
    "pre-start": ["{{ event._tag }}"],
    "post-start": ["{{ event._tag }}"],
    "post-restart": ["{{ event._tag }}"],
  });
  const harness = makeHarness({ plannedApp });
  const operation = restartApp().pipe(
    Effect.provideService(ToolingEngine, {
      id: "recording",
      run: (invocation) =>
        Effect.sync(() => {
          const name = invocation.commands[0]?.[2]?.replace(/ "[$]@"$/u, "") ?? invocation.tool;
          executed.push(name);
          return {
            tool: invocation.tool,
            service: invocation.service ?? ":lando",
            exitCode: name === failure ? 7 : 0,
            stdout: "",
            stderr: "",
          };
        }),
    }),
    Effect.provideService(RouterService, {
      ...TestRouterService,
      removeRoutes: (app) => Effect.sync(() => void routeRemovals.push(String(app))),
    }),
    Effect.provide(harness.layer),
  );
  return { ...harness, plannedApp, executed, routeRemovals, operation };
};

describe("restart lifecycle brackets", () => {
  test("restart brackets retain the inner stop and start event order", async () => {
    // Given
    const harness = restartHarness();
    // When
    await Effect.runPromise(harness.operation);
    // Then
    expect(harness.executed).toEqual([
      "pre-init",
      "post-init",
      "pre-restart",
      "pre-stop",
      "post-stop",
      "pre-start",
      "post-start",
      "post-restart",
    ]);
    expect(byTag(harness.events, "pre-restart")).toMatchObject([
      {
        scope: "app",
        app: { kind: "user", id: plan.id, root: plan.root },
        plan: harness.plannedApp,
        triggeredBy: "app:restart",
      },
    ]);
    expect(byTag(harness.events, "post-restart")).toMatchObject([
      {
        scope: "app",
        app: { kind: "user", id: plan.id, root: plan.root },
        plan: harness.plannedApp,
      },
    ]);
  });

  test("post-restart does not run when the stop/start pair fails", async () => {
    // Given
    const harness = restartHarness("pre-start");
    // When
    const error = await Effect.runPromise(Effect.flip(harness.operation));
    // Then
    expect(error).toBeInstanceOf(LandofileEventStepFailedError);
    expect(byTag(harness.events, "post-restart")).toEqual([]);
    expect(harness.executed).toEqual([
      "pre-init",
      "post-init",
      "pre-restart",
      "pre-stop",
      "post-stop",
      "pre-start",
    ]);
  });

  test("post-restart failure propagates without removing started app routes", async () => {
    // Given
    const harness = restartHarness("post-restart");
    // When
    const error = await Effect.runPromise(Effect.flip(harness.operation));
    // Then
    expect(error).toBeInstanceOf(LandofileEventStepFailedError);
    expect(harness.executed.at(-1)).toBe("post-restart");
    expect(harness.routeRemovals).toEqual([]);
  });
});
