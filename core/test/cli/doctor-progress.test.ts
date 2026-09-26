import { describe, expect, test } from "bun:test";

import { Effect, Layer, Queue, Stream } from "effect";

import { ConfigService } from "@lando/core/services";
import { type GlobalConfig, ProviderId } from "@lando/sdk/schema";
import { EventService, type EventServiceShape, type LandoEvent } from "@lando/sdk/services";
import {
  DOCTOR_TREE_ID,
  appConfigOutcome,
  certsOutcome,
  checksOutcome,
  deprecationsOutcome,
  doctorSections,
  doctorTreeSummary,
  selfCheckOutcome,
} from "../../src/cli/commands/doctor-progress.ts";
import { collectDoctorReport } from "../../src/cli/commands/doctor-report.ts";
import { doctorSelfCheck } from "../../src/cli/commands/doctor-self.ts";

const recordingEvents = () => {
  const events: Array<Record<string, unknown>> = [];
  const layer = Layer.succeed(EventService, {
    publish: (event: LandoEvent) => Effect.sync(() => events.push({ ...event })),
    subscribe: () => Stream.empty,
    subscribeQueue: Queue.unbounded<never>(),
    waitFor: () => Effect.never,
    waitForAny: () => Effect.never,
    query: () => Effect.succeed([]),
  } satisfies EventServiceShape);
  return { events, layer };
};

const globalConfig = {
  defaultProviderId: ProviderId.make("lando"),
  telemetry: { enabled: false },
} as GlobalConfig;
const configService = Layer.succeed(ConfigService, {
  load: Effect.succeed(globalConfig),
  get: (key) => Effect.succeed(globalConfig[key]),
});

const pass = { status: "pass" as const, solutions: [] };
const warn = { status: "warn" as const, solutions: [{ command: "lando restart" }] };
const fail = { status: "fail" as const, solutions: [{ description: "x" }, { command: "lando setup" }] };

describe("doctor progress outcomes", () => {
  test("lists opt-in sections only when their flag is set", () => {
    expect(doctorSections({}).map((section) => section.id)).toEqual([
      "provider",
      "certificate-authority",
      "network-trust",
      "subsystems",
      "global-app",
      "mcp",
    ]);
    expect(doctorSections({ app: true, deprecations: true }).map((section) => section.id)).toEqual([
      "provider",
      "certificate-authority",
      "network-trust",
      "subsystems",
      "global-app",
      "mcp",
      "app-version-constraints",
      "deprecations",
      "app-config",
    ]);
  });

  test("settles all-pass sections bare, warnings as a count, failures with the first command", () => {
    expect(checksOutcome("provider", [pass, pass])).toEqual({});
    expect(checksOutcome("provider", [pass, warn, warn])).toEqual({
      summary: "provider · 2 warnings",
      warned: true,
    });
    expect(checksOutcome("subsystems", [warn, fail])).toEqual({
      summary: "subsystems · 1 failure",
      failed: true,
      remediation: "lando restart",
    });
    expect(checksOutcome("mcp", [fail])).toEqual({
      summary: "mcp · 1 failure",
      failed: true,
      remediation: "lando setup",
    });
  });

  test("flags an unselected certificate authority instead of passing it", () => {
    expect(certsOutcome({ _tag: "selected", id: "mkcert" })).toEqual({
      summary: "certificate-authority · mkcert",
    });
    for (const tag of ["unresolved", "unavailable", "ambiguous", "load-failed"]) {
      expect(certsOutcome({ _tag: tag })).toEqual({
        summary: `certificate-authority · ${tag}`,
        warned: true,
      });
    }
  });

  test("flags deprecations only for warn and error severities", () => {
    expect(deprecationsOutcome({ entries: [{ severity: "info" }, { severity: "info" }] } as never)).toEqual({
      summary: "deprecations · 2 uses",
    });
    expect(deprecationsOutcome({ entries: [{ severity: "info" }, { severity: "warn" }] } as never)).toEqual({
      summary: "deprecations · 1 warning",
      warned: true,
    });
  });

  test("summarizes deprecations and app config", () => {
    expect(deprecationsOutcome({ entries: [] })).toEqual({ summary: "deprecations · none" });
    expect(deprecationsOutcome({ entries: [{ severity: "warn" }, { severity: "error" }] } as never)).toEqual({
      summary: "deprecations · 1 error",
      failed: true,
    });
    expect(appConfigOutcome(undefined)).toEqual({ summary: "app-config · skipped" });
    expect(appConfigOutcome({ app: "a", file: "f", valid: true, violations: [] })).toEqual({});
    expect(
      appConfigOutcome({ app: "a", file: "f", valid: false, violations: [{ path: "x", message: "m" }] }),
    ).toEqual({ summary: "app-config · 1 violation", failed: true });
  });

  test("fails a section from its self check with the self remediation command", () => {
    const self = doctorSelfCheck({
      section: "provider",
      reason: "timeout",
      message: "took too long",
      solutions: [{ kind: "manual", description: "Retry.", command: "lando doctor" }],
    });
    expect(selfCheckOutcome("provider", self)).toEqual({
      summary: "provider · timeout",
      failed: true,
      remediation: "lando doctor",
    });
  });

  test("names the tree summary by the worst outcome", () => {
    expect(doctorTreeSummary({ failed: 0, warned: 0 })).toBe("doctor · healthy");
    expect(doctorTreeSummary({ failed: 0, warned: 3 })).toBe("doctor · 3 warnings");
    expect(doctorTreeSummary({ failed: 2, warned: 3 })).toBe("doctor · 2 problems found");
  });
});

describe("doctor progress events", () => {
  test("publishes one task per section between tree start and tree complete", async () => {
    const recorder = recordingEvents();
    const report = await Effect.runPromise(
      collectDoctorReport({
        options: { env: {} },
        provider: Effect.succeed({
          checks: [
            {
              name: "selected-provider",
              status: "warn",
              severity: "warn",
              providerId: "lando",
              providerName: "Lando",
              providerVersion: "0.0.0",
              providerKind: "managed",
              runtimeStatus: "running",
              runtime: { running: true },
              capabilities: {},
              context: {},
              solutions: [{ kind: "manual", description: "Restart.", command: "lando restart" }],
            },
          ],
        }),
        deprecations: Effect.succeed({ entries: [] }),
        certs: Effect.succeed({ _tag: "selected", id: "mkcert" }),
      }).pipe(Effect.provide(Layer.merge(recorder.layer, configService))),
    );

    const tags = recorder.events.map((event) => event._tag);
    expect(tags[0]).toBe("task.tree.start");
    expect(tags[tags.length - 1]).toBe("task.tree.complete");
    expect(recorder.events[0]).toMatchObject({
      parentId: DOCTOR_TREE_ID,
      label: "doctor",
      children: ["provider", "certificate-authority", "network-trust", "subsystems", "global-app", "mcp"],
    });
    const starts = recorder.events
      .filter((event) => event._tag === "task.start")
      .map((event) => event.taskId);
    expect(starts).toEqual([
      "provider",
      "certificate-authority",
      "network-trust",
      "subsystems",
      "global-app",
      "mcp",
    ]);
    expect(recorder.events.filter((event) => event._tag === "task.fail")).toEqual([]);
    expect(recorder.events.find((event) => event._tag === "task.complete")).toMatchObject({
      taskId: "provider",
      summary: "provider · 1 warning",
      outcome: "warn",
    });
    expect(
      recorder.events.find(
        (event) => event._tag === "task.complete" && event.taskId === "certificate-authority",
      ),
    ).not.toHaveProperty("outcome");
    expect(
      recorder.events.find(
        (event) => event._tag === "task.complete" && event.taskId === "certificate-authority",
      ),
    ).toMatchObject({ summary: "certificate-authority · mkcert" });
    expect(recorder.events[recorder.events.length - 1]).toMatchObject({
      parentId: DOCTOR_TREE_ID,
      succeeded: 6,
      failed: 0,
    });
    expect(report.provider.checks).toHaveLength(1);
  });

  test("fails the section task when doctor could not run the section", async () => {
    const recorder = recordingEvents();
    await Effect.runPromise(
      collectDoctorReport({
        options: { env: {} },
        provider: Effect.die(new Error("provider exploded")),
        deprecations: Effect.succeed({ entries: [] }),
        certs: Effect.succeed({ _tag: "unresolved" }),
      }).pipe(Effect.provide(Layer.merge(recorder.layer, configService))),
    );
    const failures = recorder.events.filter((event) => event._tag === "task.fail");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ taskId: "provider", summary: "provider · defect" });
    expect(recorder.events[recorder.events.length - 1]).toMatchObject({
      _tag: "task.tree.complete",
      summary: "doctor · 1 problem found",
      failed: 1,
    });
  });

  test("fails the provider task when a provider sub-probe could not run", async () => {
    const recorder = recordingEvents();
    await Effect.runPromise(
      collectDoctorReport({
        options: { env: {} },
        provider: Effect.succeed({
          checks: [],
          selfChecks: [doctorSelfCheck({ section: "provider-status", reason: "timeout", message: "slow" })],
        }),
        deprecations: Effect.succeed({ entries: [] }),
        certs: Effect.succeed({ _tag: "selected", id: "mkcert" }),
      }).pipe(Effect.provide(Layer.merge(recorder.layer, configService))),
    );
    expect(recorder.events.filter((event) => event._tag === "task.fail")).toMatchObject([
      { taskId: "provider", summary: "provider · timeout" },
    ]);
    expect(recorder.events[recorder.events.length - 1]).toMatchObject({
      _tag: "task.tree.complete",
      failed: 1,
    });
  });

  test("stays silent without an event service", async () => {
    const report = await Effect.runPromise(
      collectDoctorReport({
        options: { env: {} },
        provider: Effect.succeed({ checks: [] }),
        deprecations: Effect.succeed({ entries: [] }),
        certs: Effect.succeed({ _tag: "unresolved" }),
      }).pipe(Effect.provide(configService)),
    );
    expect(report.provider.checks).toEqual([]);
  });
});
