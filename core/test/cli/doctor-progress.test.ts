import { describe, expect, test } from "bun:test";
import { ConfigService } from "@lando/core/services";
import { type ConfigLintResult, type GlobalConfig, ProviderId } from "@lando/sdk/schema";
import { EventService, type EventServiceShape, type LandoEvent } from "@lando/sdk/services";
import { Effect, Layer, Queue, Stream } from "effect";
import { appConfigFindings } from "../../src/cli/commands/doctor-app-config";
import { resilientDoctorReport } from "../../src/cli/commands/doctor-bootstrap";
import { type CertsDoctorStatus, certsSubsystemCheck } from "../../src/cli/commands/doctor-certs-status";
import type { DoctorSectionResult } from "../../src/cli/commands/doctor-contract";
import { deprecationFindings } from "../../src/cli/commands/doctor-deprecations";
import { DOCTOR_TREE_ID, checksOutcome, doctorTreeSummary } from "../../src/cli/commands/doctor-progress.ts";
import { collectDoctorReport } from "../../src/cli/commands/doctor-report.ts";
import { independentSection, runtimeSection } from "../../src/cli/commands/doctor-sections";
import { doctorSelfCheck } from "../../src/cli/commands/doctor-self.ts";
import { makeLandoRuntime } from "../../src/runtime/layer";
import { healthyFilesystemWatch } from "./doctor-watch-fixture.ts";

const recordingEvents = () => {
  const events: Array<Record<string, unknown>> = [];
  const layer = Layer.succeed(
    EventService,
    EventService.of({
      publish: (event: LandoEvent) => Effect.sync(() => events.push({ ...event })),
      subscribe: () => Stream.empty,
      subscribeQueue: Queue.unbounded<never>(),
      waitFor: () => Effect.never,
      subscribeWithHistory: () => Effect.never,
      waitForAny: () => Effect.never,
      query: () => Effect.succeed([]),
    } satisfies EventServiceShape),
  );
  return { events, layer };
};

const globalConfig = {
  defaultProviderId: ProviderId.make("lando"),
  telemetry: { enabled: false },
} as GlobalConfig;
const configService = Layer.succeed(
  ConfigService,
  ConfigService.of({
    load: Effect.succeed(globalConfig),
    get: (key) => Effect.succeed(globalConfig[key]),
  }),
);

const pass = { status: "pass" as const, solutions: [] };
const warn = {
  status: "warn" as const,
  solutions: [{ kind: "manual" as const, description: "Restart.", command: "lando restart" }],
};
const fail = {
  status: "fail" as const,
  solutions: [
    { kind: "manual" as const, description: "x" },
    { kind: "manual" as const, description: "Set up.", command: "lando setup" },
  ],
};

const DEFAULT_SECTIONS = [
  "provider",
  "certificate-authority",
  "network-trust",
  "subsystems",
  "global-app",
  "mcp",
  "accelerated-starts",
  "missing-app-roots",
  "orphaned-volume-snapshots",
  "legacy-snapshot-catalogs",
  "filesystem-watch",
  "debugger-host",
] as const;

const progressTable = (
  provider: Effect.Effect<DoctorSectionResult, never> = Effect.succeed({ checks: [] }),
  certs: CertsDoctorStatus = { _tag: "unresolved" },
) => [
  independentSection({ id: "provider", run: provider }),
  independentSection({
    id: "app-listeners",
    when: (options) => options.app === true,
    run: Effect.succeed({ checks: [] }),
    isolate: false,
  }),
  ...DEFAULT_SECTIONS.slice(1).map((id) =>
    independentSection({
      id,
      run:
        id === "certificate-authority"
          ? certsSubsystemCheck(certs, false).pipe(
              Effect.map((check): DoctorSectionResult => ({ checks: check === undefined ? [] : [check] })),
            )
          : Effect.succeed({ checks: [] }),
    }),
  ),
  independentSection({
    id: "app-version-constraints",
    when: (options) => options.app === true,
    run: Effect.succeed({ checks: [] }),
  }),
  independentSection({
    id: "deprecations",
    when: (options) => options.deprecations === true,
    run: Effect.succeed({ checks: [] }),
  }),
  independentSection({
    id: "app-config",
    when: (options) => options.app === true,
    run: Effect.succeed({ checks: [] }),
  }),
];

describe("doctor progress outcomes", () => {
  test.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "publishes enabled sections in order with unchanged labels (app=%s, deprecations=%s)",
    async (app, deprecations) => {
      const recorder = recordingEvents();
      const expected = [
        "provider",
        ...(app ? ["app-listeners"] : []),
        ...DEFAULT_SECTIONS.slice(1),
        ...(app ? ["app-version-constraints"] : []),
        ...(deprecations ? ["deprecations"] : []),
        ...(app ? ["app-config"] : []),
      ];
      await Effect.runPromise(
        collectDoctorReport({
          options: { app, deprecations, env: {} },
          contexts: {},
          table: progressTable(),
        }).pipe(Effect.provide(Layer.mergeAll(recorder.layer, configService, healthyFilesystemWatch))),
      );
      expect(recorder.events[0]).toMatchObject({ _tag: "task.tree.start", children: expected });
      expect(
        recorder.events
          .filter((event) => event._tag === "task.start")
          .map((event) => ({ id: event.taskId, label: event.label })),
      ).toEqual(expected.map((id) => ({ id, label: id })));
    },
  );

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

  test("names the tree summary by the worst outcome", () => {
    expect(doctorTreeSummary({ failed: 0, warned: 0 })).toBe("doctor · healthy");
    expect(doctorTreeSummary({ failed: 0, warned: 3 })).toBe("doctor · 3 warnings");
    expect(doctorTreeSummary({ failed: 2, warned: 3 })).toBe("doctor · 2 problems found");
  });
});

describe("doctor progress events", () => {
  test("selected sections alone get rows, in table order", async () => {
    const recorder = recordingEvents();
    await Effect.runPromise(
      collectDoctorReport({
        options: { env: {}, sections: ["app-config", "mcp"] },
        contexts: {},
        table: progressTable(),
      }).pipe(Effect.provide(recorder.layer)),
    );
    expect(recorder.events[0]).toMatchObject({ _tag: "task.tree.start", children: ["mcp", "app-config"] });
    expect(
      recorder.events.filter((event) => event._tag === "task.start").map((event) => event.taskId),
    ).toEqual(["mcp", "app-config"]);
  });

  test("a provider-bootstrap self check fails the provider row instead of reporting it skipped", async () => {
    const recorder = recordingEvents();
    await Effect.runPromise(
      collectDoctorReport({
        options: { env: {} },
        contexts: {},
        table: [runtimeSection({ id: "provider", run: Effect.succeed({ checks: [] }) })],
        initialChecks: [
          {
            section: "provider",
            name: "doctor-self",
            status: "fail",
            severity: "error",
            context: { probe: "provider-bootstrap", reason: "defect" },
            solutions: [
              { kind: "manual", description: "Validate config.", command: "lando config validate" },
            ],
          },
        ],
      }).pipe(Effect.provide(recorder.layer)),
    );
    expect(recorder.events.filter((event) => event._tag === "task.fail")).toMatchObject([
      { taskId: "provider", summary: "provider · 1 failure", remediation: "lando config validate" },
    ]);
  });

  test("config failure still paints independent and skipped section rows", async () => {
    const recorder = recordingEvents();
    const runtime = makeLandoRuntime({
      bootstrap: "none",
      configSources: { user: false, env: false },
      config: { router: { httpPort: 99999 } },
    });
    const report = await Effect.runPromise(
      resilientDoctorReport({ env: {}, platform: "darwin" }).pipe(
        Effect.provide(runtime),
        Effect.provide(recorder.layer),
      ),
    );
    expect(report.checks.find((check) => check.section === "mcp")?.status).toBe("pass");
    expect(report.checks.find((check) => check.section === "global-config")?.status).toBe("fail");
    expect(recorder.events[0]).toMatchObject({
      _tag: "task.tree.start",
      children: ["global-config", ...DEFAULT_SECTIONS],
    });
    expect(
      recorder.events.filter((event) => event._tag === "task.start").map((event) => event.taskId),
    ).toEqual(["global-config", ...DEFAULT_SECTIONS]);
    expect(recorder.events.filter((event) => event._tag === "task.fail")).toMatchObject([
      { taskId: "global-config", summary: "global-config · 1 failure", remediation: "lando config validate" },
    ]);
    expect(
      recorder.events.find((event) => event._tag === "task.complete" && event.taskId === "provider"),
    ).toMatchObject({ outcome: "info", summary: "provider · skipped" });
  });

  test("publishes one task per section between tree start and tree complete", async () => {
    const recorder = recordingEvents();
    const report = await Effect.runPromise(
      collectDoctorReport({
        options: { env: {} },
        contexts: {},
        table: progressTable(
          Effect.succeed({
            checks: [
              {
                name: "selected-provider",
                status: "warn",
                severity: "warn",
                context: {},
                solutions: [{ kind: "manual", description: "Restart.", command: "lando restart" }],
              },
            ],
          }),
          { _tag: "selected", id: "mkcert", trusted: true },
        ),
      }).pipe(Effect.provide(Layer.mergeAll(recorder.layer, configService, healthyFilesystemWatch))),
    );

    const tags = recorder.events.map((event) => event._tag);
    expect(tags[0]).toBe("task.tree.start");
    expect(tags[tags.length - 1]).toBe("task.tree.complete");
    expect(recorder.events[0]).toMatchObject({
      parentId: DOCTOR_TREE_ID,
      label: "doctor",
      children: DEFAULT_SECTIONS,
    });
    const starts = recorder.events
      .filter((event) => event._tag === "task.start")
      .map((event) => event.taskId);
    expect(starts).toEqual([...DEFAULT_SECTIONS]);
    expect(recorder.events.filter((event) => event._tag === "task.fail")).toEqual([]);
    expect(
      recorder.events.find((event) => event._tag === "task.complete" && event.taskId === "provider"),
    ).toMatchObject({
      taskId: "provider",
      summary: "provider · 1 warning",
      outcome: "warn",
    });
    const certificate = recorder.events.find(
      (event) => event._tag === "task.complete" && event.taskId === "certificate-authority",
    );
    expect(certificate).toMatchObject({ _tag: "task.complete", taskId: "certificate-authority" });
    expect(certificate).not.toHaveProperty("outcome");
    expect(recorder.events[recorder.events.length - 1]).toMatchObject({
      parentId: DOCTOR_TREE_ID,
      succeeded: DEFAULT_SECTIONS.length,
      failed: 0,
    });
    expect(report.checks.filter((check) => check.section === "provider")).toHaveLength(1);
  });

  test("fails the section task when doctor could not run the section", async () => {
    const recorder = recordingEvents();
    await Effect.runPromise(
      collectDoctorReport({
        options: { env: {} },
        contexts: {},
        table: progressTable(Effect.die(new Error("provider exploded")), {
          _tag: "selected",
          id: "mkcert",
          trusted: true,
        }),
      }).pipe(Effect.provide(Layer.mergeAll(recorder.layer, configService, healthyFilesystemWatch))),
    );
    const failures = recorder.events.filter((event) => event._tag === "task.fail");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ taskId: "provider", summary: "provider · 1 failure" });
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
        contexts: {},
        table: progressTable(
          Effect.succeed({
            checks: [
              doctorSelfCheck({
                section: "provider",
                probe: "provider-status",
                reason: "timeout",
                message: "slow",
                solutions: [{ kind: "manual", description: "Retry.", command: "lando doctor" }],
              }),
            ],
          }),
          { _tag: "selected", id: "mkcert", trusted: true },
        ),
      }).pipe(Effect.provide(Layer.mergeAll(recorder.layer, configService, healthyFilesystemWatch))),
    );
    expect(recorder.events.filter((event) => event._tag === "task.fail")).toMatchObject([
      { taskId: "provider", summary: "provider · 1 failure" },
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
        contexts: {},
        table: progressTable(),
      }).pipe(Effect.provide(Layer.merge(configService, healthyFilesystemWatch))),
    );
    expect(report.checks.filter((check) => check.section === "provider")).toEqual([]);
  });
});

describe("restored doctor progress outcomes", () => {
  test("flags an unselected certificate authority instead of passing it", async () => {
    const recorder = recordingEvents();
    await Effect.runPromise(
      collectDoctorReport({
        options: { env: {} },
        contexts: {},
        table: progressTable(),
      }).pipe(Effect.provide(Layer.mergeAll(recorder.layer, configService, healthyFilesystemWatch))),
    );
    const unresolved = recorder.events.find(
      (event) => event._tag === "task.complete" && event.taskId === "certificate-authority",
    );
    expect(unresolved).toMatchObject({ outcome: "warn" });

    const trusted = recordingEvents();
    await Effect.runPromise(
      collectDoctorReport({
        options: { env: {} },
        contexts: {},
        table: progressTable(undefined, { _tag: "selected", id: "mkcert", trusted: true }),
      }).pipe(Effect.provide(Layer.mergeAll(trusted.layer, configService, healthyFilesystemWatch))),
    );
    const selected = trusted.events.find(
      (event) => event._tag === "task.complete" && event.taskId === "certificate-authority",
    );
    expect(selected).toMatchObject({ _tag: "task.complete", taskId: "certificate-authority" });
    expect(selected).not.toHaveProperty("outcome");
  });

  test("flags deprecations only for warn and error severities", () => {
    const entry = (severity: "info" | "warn" | "error") => ({
      kind: "flag" as const,
      id: "legacy-flag",
      severity,
      since: "4.1.0",
      note: "Rename the flag.",
      source: "core",
      count: 1,
    });
    const info = checksOutcome(
      "deprecations",
      deprecationFindings({ entries: [entry("info"), entry("info")] }),
    );
    expect(info).toEqual({});
    const warn = checksOutcome(
      "deprecations",
      deprecationFindings({ entries: [entry("info"), entry("warn")] }),
    );
    expect(warn).toEqual({ summary: "deprecations · 1 warning", warned: true });
    const error = checksOutcome(
      "deprecations",
      deprecationFindings({ entries: [entry("warn"), entry("error")] }),
    );
    expect(error).toEqual({ summary: "deprecations · 1 failure", failed: true });
  });

  test("summarizes deprecations and app config", () => {
    expect(deprecationFindings({ entries: [] })).toEqual([]);
    expect(
      checksOutcome(
        "deprecations",
        deprecationFindings({
          entries: [
            {
              kind: "command",
              id: "app:legacy",
              severity: "warn",
              since: "4.1.0",
              note: "Replace the command.",
              source: "app:demo",
              count: 2,
            },
          ],
        }),
      ),
    ).toEqual({ summary: "deprecations · 1 warning", warned: true });

    const lint = (violations: ConfigLintResult["violations"]) => ({
      app: "a",
      file: "f",
      valid: !violations.some((violation) => violation.severity === "error"),
      violations,
    });
    expect(checksOutcome("app-config", appConfigFindings(lint([])))).toEqual({});
    expect(
      checksOutcome(
        "app-config",
        appConfigFindings(
          lint([
            {
              rule: "env-file.literal",
              severity: "warning",
              path: ["env_file", 0],
              message: "literal",
            },
          ]),
        ),
      ),
    ).toEqual({ summary: "app-config · 1 warning", warned: true });
    expect(
      checksOutcome(
        "app-config",
        appConfigFindings(
          lint([
            {
              rule: "landofile.validation",
              severity: "error",
              path: ["x"],
              message: "m",
            },
          ]),
        ),
      ),
    ).toEqual({ summary: "app-config · 1 failure", failed: true });
  });

  test("fails a section from its self check with the self remediation command", () => {
    const self = doctorSelfCheck({
      section: "provider",
      reason: "timeout",
      message: "took too long",
      solutions: [{ kind: "manual", description: "Retry.", command: "lando doctor" }],
    });
    expect(checksOutcome("provider", [self])).toEqual({
      summary: "provider · 1 failure",
      failed: true,
      remediation: "lando doctor",
    });
  });
});
