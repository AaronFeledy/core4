import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type LandofileShape,
  PortablePath,
  ProviderId,
} from "@lando/sdk/schema";

import { runAppEvent } from "../../src/operations/events.ts";
import {
  attachEffectiveEvents,
  compileEffectiveEvents,
  effectiveEventsForPlan,
} from "../../src/planner/effective-events.ts";
import { compileEffectiveTooling } from "../../src/planner/effective-tooling.ts";

const eventPlan = (): AppPlan => ({
  id: AppId.make("same-app"),
  name: "same-app",
  slug: "same-app",
  root: AbsolutePath.make("/tmp/same-app"),
  provider: ProviderId.make("lando"),
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: { resolvedAt: DateTime.unsafeMake("2026-08-16T00:00:00Z"), source: "test", runtime: 4 },
  extensions: {},
});

describe("compileEffectiveTooling", () => {
  test("authored tasks win wholesale over service-type tasks", () => {
    // Given
    const landofile: LandofileShape = {
      toolingDefaults: { service: "fallback", env: { DEFAULT_ONLY: "default" } },
      tooling: { inspect: { cmd: "authored", description: "authored task" } },
    };

    // When
    const tooling = compileEffectiveTooling({
      landofile,
      services: [
        {
          name: "web",
          tooling: {
            inspect: { cmd: "service", description: "service task", env: { SERVICE_ONLY: "service" } },
          },
        },
      ],
    });

    // Then
    expect(tooling.inspect).toEqual({
      cmd: "authored",
      description: "authored task",
      service: "fallback",
      env: { DEFAULT_ONLY: "default" },
    });
  });

  test("the lexicographically first service owns a same-tier task", () => {
    // Given / When
    const tooling = compileEffectiveTooling({
      landofile: {},
      services: [
        { name: "zeta", tooling: { inspect: { cmd: "from-zeta" } } },
        { name: "alpha", tooling: { inspect: { cmd: "from-alpha" } } },
      ],
    });

    // Then
    expect(tooling.inspect).toEqual({ cmd: "from-alpha", service: "alpha" });
  });

  test("uses ordinal ordering for non-ASCII service conflicts and output across permutations", () => {
    // Given
    const services = [
      {
        name: "zeta",
        tooling: { inspect: { cmd: "from-zeta" }, "z-task": { cmd: "z" } },
      },
      {
        name: "äther",
        tooling: { inspect: { cmd: "from-ather" }, "ä-task": { cmd: "a" } },
      },
    ] as const;

    for (const permutation of [services, [...services].reverse()]) {
      // When
      const tooling = compileEffectiveTooling({ landofile: {}, services: permutation });

      // Then
      expect(tooling.inspect).toEqual({ cmd: "from-zeta", service: "zeta" });
      expect(Object.keys(tooling)).toEqual(["inspect", "z-task", "ä-task"]);
    }
  });

  test("defaults fill only after service contribution merge", () => {
    // Given / When
    const tooling = compileEffectiveTooling({
      landofile: {
        toolingDefaults: {
          service: "fallback",
          dir: PortablePath.make("/workspace/default"),
          env: { DEFAULT_ONLY: "default", SHARED: "default" },
          vars: { DEFAULT_VAR: "default", SHARED_VAR: "default" },
        },
      },
      services: [
        {
          name: "worker",
          tooling: {
            inspect: {
              cmd: "env",
              env: { SERVICE_ONLY: "service", SHARED: "service" },
              vars: { SERVICE_VAR: "service", SHARED_VAR: "service" },
            },
          },
        },
      ],
    });

    // Then
    expect(tooling.inspect).toEqual({
      cmd: "env",
      service: "worker",
      dir: PortablePath.make("/workspace/default"),
      env: { DEFAULT_ONLY: "default", SERVICE_ONLY: "service", SHARED: "service" },
      vars: { DEFAULT_VAR: "default", SERVICE_VAR: "service", SHARED_VAR: "service" },
    });
  });
});

describe("compileEffectiveEvents", () => {
  test("authored event lists replace lexicographically deterministic service contributions", () => {
    // Given / When
    const events = compileEffectiveEvents({
      landofile: { events: { "pre-start": ["echo authored"] } },
      services: [
        { name: "zeta", events: { "pre-start": ["echo zeta"], "post-start": ["echo zeta post"] } },
        { name: "alpha", events: { "pre-start": ["echo alpha"], "post-start": ["echo alpha post"] } },
      ],
    });

    // Then
    expect(events).toEqual({
      "post-start": ["echo alpha post"],
      "pre-start": ["echo authored"],
    });
  });

  test("plans with the same id and root do not inherit another plan's events", () => {
    // Given
    const shared = eventPlan();
    const first = { ...shared };
    const second = { ...shared };

    // When
    attachEffectiveEvents(first, { "pre-start": ["echo first"] });

    // Then
    expect(effectiveEventsForPlan(first)?.["pre-start"]).toEqual(["echo first"]);
    expect(effectiveEventsForPlan(second)).toBeUndefined();
  });

  test("a plan without event steps runs without event runtime services", async () => {
    // Given
    const plan = eventPlan();

    // When
    const exit = await Effect.runPromiseExit(runAppEvent(plan, "pre-start"));

    // Then
    expect(exit._tag).toBe("Success");
  });

  test("caller-supplied authored steps cannot bypass effective plan provenance", async () => {
    // Given
    const plan = eventPlan();

    // When
    const exit = await Effect.runPromiseExit(
      Reflect.apply(runAppEvent, undefined, [plan, "pre-start", ["echo unplanned"]]),
    );

    // Then
    expect(exit._tag).toBe("Success");
  });
});
