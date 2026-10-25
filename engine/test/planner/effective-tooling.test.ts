import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Schema } from "effect";

import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { rememberInternalToolingTasks } from "@lando/landofile/tooling-include-provenance";
import { AbsolutePath, AppId, AppPlan, LandofileShape, PortablePath, ProviderId } from "@lando/sdk/schema";
import { validEventNames } from "../../src/planner/event-names.ts";

import { runAppEvent } from "../../src/operations/events.ts";
import {
  compileEffectiveEvents,
  effectiveEventsForPlan,
  eventStepsFromCompiled,
  withProjectEvents,
} from "../../src/planner/effective-events.ts";
import * as toolingForPlan from "../../src/planner/effective-tooling.ts";
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
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-08-16T00:00:00Z"), source: "test", runtime: 4 },
  extensions: {},
});

describe("compileEffectiveTooling", () => {
  test.each([false, { disabled: true }])(
    "persists the authored disable source for a service-type task %j",
    async (disabled) => {
      const file = "/tmp/same-app/.lando.local.yml";
      const compiled = await Effect.runPromise(
        loadAuthoredDocuments([{ file, value: { tooling: { inspect: disabled } } }], {
          appRoot: "/tmp/same-app",
          file,
        }),
      );
      const tasks = compileEffectiveTooling({
        landofile: compiled.document,
        services: [{ name: "web", tooling: { inspect: { cmd: "service-type" } } }],
      });
      const plan = toolingForPlan.attachEffectiveTooling(
        eventPlan(),
        tasks,
        {},
        toolingForPlan.disabledToolingSources(compiled.document, tasks),
      );
      const roundTrip = Schema.decodeUnknownSync(AppPlan)(Schema.encodeSync(AppPlan)(plan));
      expect(toolingForPlan.effectiveToolingForPlan(roundTrip)?.inspect).toEqual({ disabled: true });
      expect(toolingForPlan.disabledToolingSourceForPlan(roundTrip, "inspect")).toBe(file);
    },
  );
  test("false drops a service-type task definition wholesale", () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({ tooling: { inspect: false } });
    // When
    const tooling = compileEffectiveTooling({
      landofile,
      services: [
        { name: "web", tooling: { inspect: { cmd: "inspect", flags: { loud: { boolean: true } } } } },
      ],
    });
    // Then
    expect(tooling.inspect).toEqual({ disabled: true });
  });
  test("attachment preserves internal include provenance", () => {
    // Given
    const landofile = rememberInternalToolingTasks(
      { tooling: { "ops:migrate": { cmd: "migrate" }, inspect: { cmd: "inspect" } } },
      ["ops:migrate"],
    );
    const tooling = compileEffectiveTooling({ landofile, services: [] });
    // When
    const plan = toolingForPlan.attachEffectiveTooling(eventPlan(), tooling);
    const attached = toolingForPlan.effectiveToolingForPlan(plan);
    // Then
    expect(attached).toEqual(tooling);
    if (attached === undefined) throw new Error("missing attached tooling");
    expect(validEventNames(attached)).toEqual(validEventNames(tooling));
    expect(validEventNames(attached)).not.toContain("pre-ops:migrate");
  });
  test("returns attached effective tasks when tooling is attached to a plan", () => {
    // Given
    const basePlan = eventPlan();
    const tooling = compileEffectiveTooling({
      landofile: { toolingDefaults: { env: { COUNT: "2" } } },
      services: [
        { name: "web", tooling: { inspect: { cmd: "inspect", flags: { loud: { boolean: true } } } } },
      ],
    });
    const plan = toolingForPlan.attachEffectiveTooling(basePlan, tooling);
    // When
    const attached = toolingForPlan.effectiveToolingForPlan(plan);
    // Then
    expect(attached).toEqual(tooling);
  });

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

  test("service tooling can override a global dir while custom tasks inherit it", () => {
    // Given / When
    const tooling = compileEffectiveTooling({
      landofile: {
        toolingDefaults: { dir: PortablePath.make("/app") },
        tooling: { custom: { service: "database", cmd: ["pwd"] } },
      },
      services: [
        {
          name: "database",
          tooling: {
            mariadb: {
              service: "database",
              dir: PortablePath.make("/"),
              cmd: ["mariadb"],
            },
          },
        },
      ],
    });

    // Then
    expect(tooling.mariadb?.dir).toBe(PortablePath.make("/"));
    expect(tooling.custom?.dir).toBe(PortablePath.make("/app"));
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
  test("effective events come only from the resolved landofile events map in authored order", () => {
    // Given / When
    const events = compileEffectiveEvents({
      landofile: {
        events: {
          "pre-start": ["echo first", "echo second"],
          "post-start": ["echo after"],
        },
      },
    });

    // Then
    expect(eventStepsFromCompiled(events)).toEqual({
      "post-start": ["echo after"],
      "pre-start": ["echo first", "echo second"],
    });
  });

  test("events are a plan value: a spread keeps them and a plan built without them has none", () => {
    // Given
    const first = withProjectEvents(eventPlan(), { "pre-start": ["echo first"] });

    // When
    const spread = { ...first, fileSync: [] };
    const second = eventPlan();

    // Then
    expect(effectiveEventsForPlan(spread)?.["pre-start"]).toEqual(["echo first"]);
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

describe("reserved tooling compilation before shared validation", () => {
  test("retains service-type tasks for shared validation", () => {
    // Given
    const landofile: LandofileShape = {};
    const services = [{ name: "web", serviceTypeId: "php", tooling: { inspect: { cmd: "php -v" } } }];

    // When
    const tooling = compileEffectiveTooling({ landofile, services });

    // Then
    expect(tooling.inspect).toEqual({
      cmd: "php -v",
      service: "web",
    });
  });

  test("retains a reserved service-type task for shared validation", () => {
    // Given
    const landofile: LandofileShape = {};
    const services = [{ name: "web", serviceTypeId: "php", tooling: { run: { cmd: "php" } } }];

    // When
    const tooling = compileEffectiveTooling({ landofile, services });

    // Then
    expect(tooling.run).toEqual({ cmd: "php", service: "web" });
  });

  test("retains every reserved name for aggregation by shared validation", () => {
    // Given
    const landofile: LandofileShape = {};
    const services = [
      {
        name: "web",
        serviceTypeId: "php",
        tooling: {
          "scratch:gc": { cmd: "gc" },
          scratch: { cmd: "scratch" },
        },
      },
    ];

    // When
    const tooling = compileEffectiveTooling({ landofile, services });

    // Then
    expect(Object.keys(tooling)).toEqual(["scratch", "scratch:gc"]);
  });

  test("authored reserved tooling replaces a service-type task before shared validation", () => {
    // Given
    const landofile: LandofileShape = { tooling: { run: { cmd: "authored" } } };
    const services = [{ name: "web", serviceTypeId: "php", tooling: { run: { cmd: "php" } } }];

    // When
    const tooling = compileEffectiveTooling({ landofile, services });

    // Then
    expect(tooling.run).toEqual({ cmd: "authored" });
  });

  test("a disabled reserved task from the first contributing service claims nothing", () => {
    // Given
    const landofile: LandofileShape = {};
    const services = [
      { name: "a", serviceTypeId: "php", tooling: { run: { cmd: "php", disabled: true } } },
      { name: "b", serviceTypeId: "node", tooling: { run: { cmd: "node" } } },
    ];

    // When
    const tooling = compileEffectiveTooling({ landofile, services });

    // Then
    expect(tooling.run).toMatchObject({
      service: "a",
      disabled: true,
    });
  });
});
