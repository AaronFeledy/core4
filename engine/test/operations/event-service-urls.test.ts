import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { authoredInvocationSites, compileInvocationSites } from "@lando/landofile/compiled-sites";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { AppliedStateVersionError, ConfigExpressionError } from "@lando/sdk/errors";
import type {
  AppPlan,
  HostEvents,
  LandofileEventName,
  LandofileEvents,
  RoutePlan,
  ToolingTaskShape,
} from "@lando/sdk/schema";
import {
  RouterService,
  RuntimeProviderRegistry,
  ToolingEngine,
  type ToolingInvocation,
} from "@lando/sdk/services";
import { makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Layer } from "effect";
import { runEventToolingCommand } from "../../src/operations/event-tooling-command.ts";
import { runAppEvent } from "../../src/operations/events.ts";
import { compileEffectiveEvents, withEventsPlan } from "../../src/planner/effective-events.ts";
import { attachEffectiveTooling } from "../../src/planner/effective-tooling.ts";
import { attachInvocationAuthority } from "../../src/planner/invocation-authority.ts";
import { EventCommandExecutor } from "../../src/services/event-command-executor.ts";
import * as LandoEventService from "../../src/services/event-service.ts";
import * as BunProcessRunner from "../../src/services/process-runner.ts";
import { testEnvironmentResolverLayerFor } from "../environment-values.ts";
import { publicUrlRouter } from "../lifecycle/route-url-fixture.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";
import { plan, web } from "./start-progress-topology-support.ts";
import { scriptHostLayer } from "./tooling-bun-script-support.ts";

const route: RoutePlan = {
  hostname: "applied.test",
  scheme: "https",
  service: web.name,
  priority: 1,
  backend: { service: web.name, port: 3000, protocol: "http" },
};
const applied: AppPlan = { ...plan, routes: [route] };
const URL = "https://applied.test:8443";
const siteTask: ToolingTaskShape = { service: "web", cmd: ["echo", "{{ services.web.url }}"] };

/** A plan whose events and `site` task carry planner-compiled invocation sites. */
const eventPlan = (events: LandofileEvents, hostEvents: HostEvents = {}): AppPlan => {
  const document = { events, tooling: { site: siteTask } };
  const sites = Effect.runSync(
    compileInvocationSites(authoredInvocationSites(document, "/app/.lando.yml"), {}, document),
  );
  return attachInvocationAuthority(
    withEventsPlan(
      attachEffectiveTooling(plan, { site: siteTask }),
      compileEffectiveEvents({ landofile: { events }, hostEvents, services: plan.services }),
    ),
    { sites },
  );
};

const runEvent = async (
  event: LandofileEventName,
  events: LandofileEvents,
  options: {
    readonly applied?: AppPlan | undefined;
    readonly appliedFailure?: AppliedStateVersionError;
    readonly hostEvents?: HostEvents;
    readonly canonicalFailure?: AppliedStateVersionError | ConfigExpressionError;
  } = {},
) => {
  const target = eventPlan(events, options.hostEvents);
  const invocations: ToolingInvocation[] = [];
  const redaction = makeRedactionService();
  const resolver = testEnvironmentResolverLayerFor(redaction);
  const layer = Layer.mergeAll(
    scriptHostLayer,
    BunProcessRunner.layer,
    resolver,
    LandoEventService.layer.pipe(Layer.provide(resolver)),
    Layer.succeed(PrivateFileAccessService, ownerOnlyFileAccess),
    Layer.succeed(RedactionService, redaction),
    Layer.succeed(RouterService, publicUrlRouter()),
    Layer.succeed(
      RuntimeProviderRegistry,
      makeTestRuntimeProviderRegistry({
        list: Effect.succeed([plan.provider]),
        readAppliedPlanStrict: () =>
          "appliedFailure" in options
            ? Effect.fail(options.appliedFailure)
            : Effect.succeed("applied" in options ? options.applied : applied),
      }),
    ),
    Layer.succeed(
      ToolingEngine,
      ToolingEngine.of({
        id: "test",
        run: (invocation) =>
          Effect.sync(() => {
            invocations.push(invocation);
            return {
              tool: invocation.tool,
              service: invocation.service ?? "web",
              exitCode: 0,
              stdout: "",
              stderr: "",
            };
          }),
      }),
    ),
  );
  const executor = EventCommandExecutor.of({
    run: (input) =>
      options.canonicalFailure !== undefined
        ? Effect.fail(options.canonicalFailure)
        : runEventToolingCommand({
            plan: target,
            name: input.command.replace(/^app:/u, ""),
            task: siteTask,
            input: { _tag: "RawArgv", argv: [] },
          }).pipe(
            Effect.map((result) => ({ exitCode: result.exitCode, stdout: "", stderr: "" })),
            Effect.provide(layer),
          ),
  });
  const result = await Effect.runPromise(
    runAppEvent(target, event).pipe(
      Effect.provideService(EventCommandExecutor, executor),
      Effect.provide(layer),
      Effect.result,
    ),
  );
  return { result, commands: invocations.flatMap((invocation) => invocation.commands) };
};

const commandText = (commands: ReadonlyArray<ReadonlyArray<string>>) =>
  commands.map((argv) => argv.join(" "));

const newerState = (remediation: string) =>
  new AppliedStateVersionError({
    providerId: "lando",
    operation: "applied-state.read",
    path: "/state/applied.json",
    storedVersion: 99,
    supportedVersion: 14,
    scope: "app",
    message: "Applied state was written by a newer Lando.",
    remediation,
  });

describe("event step service URLs", () => {
  test.each(["route", "generated"] as const)(
    "ignoreError cannot suppress a %s refusal when neither its issue nor its cause fits",
    async (kind) => {
      const error = newerState(`Upgrade Lando. ${"界".repeat(7000)}`);
      const { result, commands } = await runEvent(
        "post-start",
        { "post-start": [{ command: "app:site", ignoreError: true }, "echo must-not-run"] },
        kind === "route" ? { appliedFailure: error } : { canonicalFailure: error },
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "LandofileEventStepFailedError", issues: [], omittedIssueCount: 1 },
      });
      expect(result._tag === "Failure" && result.failure).not.toHaveProperty("cause");
      expect(commands).toEqual([]);
    },
  );

  test("bounds both summaries of an unstarted expression refusal", async () => {
    const { result } = await runEvent(
      "post-start",
      { "post-start": [{ command: "app:site" }] },
      {
        canonicalFailure: new ConfigExpressionError({
          message: "界".repeat(6000),
          remediation: "直".repeat(6000),
          expression: "{{ event.missing }}",
          path: ["cmd"],
          filePath: "/app/.lando.yml",
        }),
      },
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "LandofileEventStepFailedError" } });
    if (result._tag === "Success") throw new Error("Expected the event to refuse the expression");
    expect(Buffer.byteLength(JSON.stringify(result.failure.message))).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(JSON.stringify(result.failure.remediation))).toBeLessThanOrEqual(1024);
  });

  test("locates a host canonical command's newer-state refusal in config.yml", async () => {
    const path = ["hostEvents", "post-start", 0, "command"];
    const { result } = await runEvent(
      "post-start",
      {},
      {
        hostEvents: { "post-start": [{ command: "app:site" }] },
        canonicalFailure: newerState("Run the newer Lando."),
      },
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "LandofileEventStepFailedError",
        issues: [
          { reason: "applied-state-newer", path, source: { layer: "config-file", file: "config.yml", path } },
        ],
      },
    });
  });

  test("a newer applied state refuses the step with the provider's remediation and cause", async () => {
    const remediation = "Run the newer Lando that wrote this state.";
    const { result, commands } = await runEvent(
      "post-start",
      { "post-start": [{ cmd: "echo {{ services.web.url }}", ignoreError: true }] },
      {
        appliedFailure: newerState(remediation),
      },
    );
    expect(commands).toEqual([]);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "LandofileEventStepFailedError",
        outputTail: "",
        remediation,
        cause: { _tag: "AppliedStateVersionError", storedVersion: 99, supportedVersion: 14 },
        issues: [{ reason: "applied-state-newer", suggestion: remediation }],
      },
    });
    expect(result._tag === "Failure" && result.failure).not.toHaveProperty("exitCode");
  });
  test("resolves a direct post-start step and a canonical tooling command from the applied routes", async () => {
    // When
    const { result, commands } = await runEvent("post-start", {
      "post-start": [
        { cmd: "curl {{ services.web.url }} {{ services.web.scheme }} {{ services.web.publicPort }}" },
        { task: "site" },
        { command: "app:site" },
      ],
    });
    // Then
    expect(result._tag).toBe("Success");
    expect(commandText(commands).filter((text) => text.includes(URL))).toHaveLength(3);
    expect(commandText(commands)[0]).toContain(`curl '${URL}' 'https' '8443'`);
  });

  test.each([
    { name: "a direct step", step: { cmd: "curl {{ services.web.url }}" } },
    { name: "an inline task", step: { task: "site" } },
    { name: "a canonical command", step: { command: "app:site" } },
  ])("refuses $name during pre-start, post-stop, and post-destroy", async ({ step }) => {
    for (const event of ["pre-start", "post-stop", "post-destroy"] as const) {
      // When
      const { result, commands } = await runEvent(event, { [event]: [step] });
      // Then
      expect(commands).toEqual([]);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "LandofileEventStepFailedError",
          event,
          index: 0,
          message: expect.stringContaining(`services.web.url is unavailable: during ${event}`),
          outputTail: "",
          issues: [{ rule: "landofile.tooling", reason: "event-phase" }],
        },
      });
      // The step never ran, so no exit code is reported.
      expect(result._tag === "Failure" && result.failure).not.toHaveProperty("exitCode");
    }
  });

  test.each([
    ["{{ url.parse(services.web.url).hostname == 'applied.test' }}", 1],
    ["{{ url.parse(services.web.url).hostname == 'other.test' }}", 0],
    ["{{ number(services.web.publicPort) == 8443 }}", 1],
    ["{{ number(services.web.publicPort) == 443 }}", 0],
  ])("evaluates a step condition reading a route fact: %s", async (condition, runs) => {
    // When
    const { result, commands } = await runEvent("post-start", {
      "post-start": [{ cmd: "echo ran", if: condition }],
    });
    // Then
    expect(result._tag).toBe("Success");
    expect(commands).toHaveLength(runs);
  });

  test.each([
    { name: "a direct step", step: { cmd: "curl {{ services.web.url }}", ignoreError: true } },
    { name: "an inline task", step: { task: "site", ignoreError: true } },
    { name: "a canonical command", step: { command: "app:site", ignoreError: true } },
  ])("ignoreError does not hide a URL $name cannot resolve", async ({ step }) => {
    // When
    const { result, commands } = await runEvent(
      "post-start",
      { "post-start": ["echo before", step, "echo after"] },
      { applied: undefined },
    );
    // Then the refused step stops the event and is named as the failing step
    expect(commands).toHaveLength(1);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "LandofileEventStepFailedError",
        index: 1,
        issues: [{ reason: "app-not-started" }],
      },
    });
  });

  test("a task: script step cannot be excused from an event-phase refusal", async () => {
    // Given a script that reads a route fact, run as an excused pre-start step
    const scripts = join(String(plan.root), ".lando/scripts");
    await mkdir(scripts, { recursive: true });
    await writeFile(
      join(scripts, "smoke.bun.sh"),
      ["# ---", "# env:", '#   SITE: "{{ services.web.url }}"', "# ---", 'printf "%s" "$SITE"', ""].join(
        "\n",
      ),
    );
    try {
      // When
      const { result } = await runEvent("pre-start", {
        "pre-start": [{ task: "smoke", ignoreError: true }],
      });
      // Then
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "LandofileEventStepFailedError",
          kind: "task",
          outputTail: "",
          issues: [{ reason: "event-phase", path: ["env", "SITE"] }],
        },
      });
    } finally {
      await rm(join(String(plan.root), ".lando"), { recursive: true, force: true });
    }
  });

  test("a task: script step resolves the applied route in a post-start step", async () => {
    // Given
    const scripts = join(String(plan.root), ".lando/scripts");
    const marker = join(String(plan.root), "script-url");
    await mkdir(scripts, { recursive: true });
    await writeFile(
      join(scripts, "smoke.bun.sh"),
      [
        "# ---",
        "# env:",
        '#   SITE: "{{ services.web.url }}"',
        "# ---",
        `printf "%s" "$SITE" > ${marker}`,
        "",
      ].join("\n"),
    );
    try {
      // When
      const { result } = await runEvent("post-start", { "post-start": [{ task: "smoke" }] });
      // Then
      expect(result._tag).toBe("Success");
      expect(await Bun.file(marker).text()).toBe(URL);
    } finally {
      await rm(join(String(plan.root), ".lando"), { recursive: true, force: true });
    }
  });

  test.each([
    ["{{ 443 }}", "non-text-value"],
    ["{{ default() }}", "invalid-env-value"],
  ] as const)("a task: script env failure %s cannot be excused by ignoreError", async (value, reason) => {
    // Given a script whose env value fails validation without reading a route fact
    const scripts = join(String(plan.root), ".lando/scripts");
    await mkdir(scripts, { recursive: true });
    await writeFile(
      join(scripts, "smoke.bun.sh"),
      ["# ---", "# env:", `#   SITE: "${value}"`, "# ---", 'echo "$SITE"', ""].join("\n"),
    );
    try {
      // When it runs as an excused pre-start step
      const { result } = await runEvent("pre-start", {
        "pre-start": [{ task: "smoke", ignoreError: true }],
      });
      // Then the step that never ran still fails the event, located at its key
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "LandofileEventStepFailedError",
          kind: "task",
          outputTail: "",
          issues: [{ reason, path: ["env", "SITE"] }],
        },
      });
    } finally {
      await rm(join(String(plan.root), ".lando"), { recursive: true, force: true });
    }
  });

  test("attributes a deferred step's unresolvable URL condition to that step", async () => {
    // When
    const { result } = await runEvent(
      "post-start",
      {
        "post-start": [
          "echo first",
          { defer: "echo cleanup", if: "{{ url.parse(services.web.url).hostname == 'applied.test' }}" },
        ],
      },
      { applied: undefined },
    );
    // Then
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "LandofileEventStepFailedError", index: 1, issues: [{ reason: "app-not-started" }] },
    });
  });
});
