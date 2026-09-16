import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  GlobalConfig,
  type LandofileEvents,
  ProviderId,
  ServiceName,
  type ToolingTaskShape,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  type CommandSpec,
  ConfigService,
  type ExecTarget,
  LandofileService,
  RuntimeProviderRegistry,
  ShellRunner,
  ToolingEngine,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { DateTime, Effect, Layer, Schema } from "effect";

import { runTooling } from "../../src/operations/tooling.ts";
import { attachEffectiveEvents } from "../../src/planner/effective-events.ts";
import { attachEffectiveTooling } from "../../src/planner/effective-tooling.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-09-12T00:00:00Z"),
  source: "tooling-events.test",
  runtime: 4 as const,
} as const;

const service = {
  name: ServiceName.make("web"),
  type: "node",
  provider: ProviderId.make("test"),
  primary: true,
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

/**
 * Records the shell text of every executed step so bracket ordering is observable
 * as one flat list across event steps and tooling steps alike.
 */
const executedLabel = (command: ReadonlyArray<string>, fallback: string): string =>
  command[2]?.replace(/ "[$]@"$/u, "") ?? fallback;

const harness = (input: {
  readonly tooling: Readonly<Record<string, ToolingTaskShape>>;
  readonly events?: LandofileEvents;
  readonly failOn?: string;
  readonly omitEventRuntime?: boolean;
}) => {
  const executed: string[] = [];
  const selections: string[] = [];
  const plan: AppPlan = {
    id: AppId.make("tooling-events"),
    name: "tooling-events",
    slug: "tooling-events",
    root: AbsolutePath.make(process.cwd()),
    provider: service.provider,
    services: { [service.name]: service },
    routes: [],
    networks: [],
    fileSync: [],
    stores: [],
    metadata,
    extensions: {},
  };
  attachEffectiveTooling(plan, input.tooling);
  if (input.events !== undefined) attachEffectiveEvents(plan, input.events);

  const record = (label: string) => {
    executed.push(label);
    return label === input.failOn ? 7 : 0;
  };
  const provider = {
    ...TestRuntimeProvider,
    execStream: (_target: ExecTarget, spec: CommandSpec) =>
      Effect.succeed({ exitCode: record(executedLabel(spec.command, "exec")) }),
  };
  const config = Schema.decodeUnknownSync(GlobalConfig)({});
  const eventRuntime =
    input.omitEventRuntime === true
      ? Layer.empty
      : Layer.mergeAll(
          EventServiceLive,
          Layer.succeed(RedactionService, {
            forProfile: (profile, options) => Effect.succeed(createStandaloneRedactor(profile, options)),
          }),
        );
  const layer = Layer.mergeAll(
    eventRuntime,
    Layer.succeed(PrivateFileAccessService, ownerOnlyFileAccess),
    Layer.succeed(ToolingEngine, {
      id: "recording",
      run: (invocation) =>
        Effect.sync(() => {
          const exitCode = record(executedLabel(invocation.commands[0] ?? [], invocation.tool));
          return {
            tool: invocation.tool,
            service: invocation.service ?? String(service.name),
            exitCode,
            stdout: exitCode === 0 ? "" : Object.values(invocation.env ?? {}).join(""),
            stderr: "",
          };
        }),
    }),
    Layer.succeed(LandofileService, {
      discover: Effect.succeed({
        name: "tooling-events",
        tooling: input.tooling,
        ...(input.events === undefined ? {} : { events: input.events }),
      }),
    }),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
    Layer.succeed(ConfigService, { load: Effect.succeed(config), get: (key) => Effect.succeed(config[key]) }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([service.provider]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () =>
        Effect.sync(() => {
          selections.push("select");
          return provider;
        }),
    }),
    Layer.succeed(ShellRunner, {
      exec: (source, options) =>
        Effect.sync(() => ({
          exitCode: record([source, ...(options?.argv ?? [])][2] ?? source),
          stdout: "",
          stderr: "",
        })),
      runScript: () => Effect.die("unused script"),
      run: () => Effect.die("unused run"),
      interactive: () => Effect.die("unused interactive"),
    }),
  );
  return {
    executed,
    selections,
    plan,
    run: (name: string) => Effect.runPromise(runTooling({ name }).pipe(Effect.provide(layer), Effect.either)),
  };
};

test("brackets a top-level tooling run with its pre and post task events", async () => {
  // Given a task whose brackets are declared alongside it
  const h = harness({
    tooling: { build: { service: "web", cmds: ["echo body-one", "echo body-two"] } },
    events: {
      "pre-build": [{ cmd: "echo before", service: "web" }],
      "post-build": [{ cmd: "echo after", service: "web" }],
    },
  });
  // When the task runs from the top level
  const result = await h.run("build");
  // Then the pre bracket, both authored steps, and the post bracket run in that order
  expect(result._tag).toBe("Right");
  expect(h.executed).toEqual(["echo before", "echo body-one", "echo body-two", "echo after"]);
});

test("resolves brackets for the canonical app-prefixed task name", async () => {
  // Given a task invoked through its canonical id
  const h = harness({
    tooling: { build: { service: "web", cmd: "echo body" } },
    events: { "pre-build": [{ cmd: "echo before", service: "web" }] },
  });
  // When invoked as app:build
  await h.run("app:build");
  // Then the bracket still resolves from the stripped lookup key
  expect(h.executed).toEqual(["echo before", "echo body"]);
});

test("skips the post bracket when the task body exits non-zero", async () => {
  // Given a task whose first step fails
  const h = harness({
    tooling: { build: { service: "web", cmds: ["echo body-one", "echo body-two"] } },
    events: {
      "pre-build": [{ cmd: "echo before", service: "web" }],
      "post-build": [{ cmd: "echo after", service: "web" }],
    },
    failOn: "echo body-one",
  });
  // When the task runs
  const result = await h.run("build");
  // Then the remaining steps and the post bracket never run
  expect(h.executed).toEqual(["echo before", "echo body-one"]);
  // And the non-zero exit stays the task result rather than becoming a failure
  expect(result).toMatchObject({ _tag: "Right", right: { exitCode: 7 } });
});

test("a failing pre bracket prevents the task body", async () => {
  // Given a failing pre bracket
  const h = harness({
    tooling: { build: { service: "web", cmd: "echo body" } },
    events: { "pre-build": [{ cmd: "echo before", service: "web" }] },
    failOn: "echo before",
  });
  // When the task runs
  const result = await h.run("build");
  // Then the body never runs and the failure is tagged with the event identity
  expect(h.executed).toEqual(["echo before"]);
  expect(result).toMatchObject({
    _tag: "Left",
    left: { _tag: "LandofileEventStepFailedError", event: "pre-build", exitCode: 7 },
  });
});

test("a failing post bracket is fatal and carries the redacted output tail", async () => {
  // Given a failing post bracket whose stdout includes a secret env value
  const secret = "post-bracket-secret";
  const h = harness({
    tooling: { build: { service: "web", cmd: "echo body" } },
    events: { "post-build": [{ cmd: "echo after", service: "web", env: { SECRET: secret } }] },
    failOn: "echo after",
  });
  // When the task runs
  const result = await h.run("build");
  // Then the whole run fails rather than reporting the body's success
  expect(h.executed).toEqual(["echo body", "echo after"]);
  expect(result._tag).toBe("Left");
  if (result._tag !== "Left") throw new Error("expected post-build failure");
  if (result.left._tag !== "LandofileEventStepFailedError") {
    throw new Error(`expected LandofileEventStepFailedError, got ${result.left._tag}`);
  }
  expect(result.left).toMatchObject({
    event: "post-build",
    exitCode: 7,
  });
  expect(result.left.outputTail).toContain("[redacted]");
  expect(result.left.outputTail).not.toContain(secret);
});

test("runs an unbracketed task without requiring the event runtime", async () => {
  // Given a task with no declared brackets and no event runtime services
  const h = harness({
    tooling: { build: { service: "web", cmd: "echo body" } },
    omitEventRuntime: true,
  });
  // When the task runs
  const result = await h.run("build");
  // Then the empty-event fast path keeps the run green
  expect(result._tag).toBe("Right");
  expect(h.executed).toEqual(["echo body"]);
});

test("fails a configured bracket when the event runtime is unavailable", async () => {
  // Given a declared bracket but no event runtime services
  const h = harness({
    tooling: { build: { service: "web", cmd: "echo body" } },
    events: { "pre-build": [{ cmd: "echo before", service: "web" }] },
    omitEventRuntime: true,
  });
  // When the task runs
  const result = await h.run("build");
  // Then the bracket refuses loudly instead of being silently dropped
  expect(h.executed).toEqual([]);
  expect(result).toMatchObject({
    _tag: "Left",
    left: { _tag: "LandofileEventStepFailedError", event: "pre-build" },
  });
});

test("never selects a provider for a host-only task and its host-only brackets", async () => {
  // Given a task and brackets that all target the host
  const h = harness({
    tooling: { build: { service: ":host", cmd: "echo body" } },
    events: { "pre-build": [{ cmd: "echo before", service: ":host" }] },
  });
  // When the task runs
  const result = await h.run("build");
  // Then no provider is ever initialized
  expect(result._tag).toBe("Right");
  expect(h.executed).toEqual(["echo before", "echo body"]);
  expect(h.selections).toEqual([]);
});
