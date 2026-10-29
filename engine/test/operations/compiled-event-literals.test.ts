import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "@lando/landofile/load-expression-file";
import { loadLandofileFile } from "@lando/landofile/service";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { AbsolutePath, type AppPlan, GlobalConfig, type HostEvents } from "@lando/sdk/schema";
import {
  type CommandSpec,
  ConfigService,
  type ExecTarget,
  PluginRegistry,
  RuntimeProviderRegistry,
  SecretStore,
  type ServiceType,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Layer, Schema, Stream } from "effect";
import { runAppEvent } from "../../src/operations/events.ts";
import * as Invocation from "../../src/operations/tooling-compile.ts";
import { effectiveToolingForPlan } from "../../src/planner/effective-tooling.ts";
import * as Registry from "../../src/plugins/registry.ts";
import * as Resolver from "../../src/services/environment-value-resolver.ts";
import {
  EventCommandExecutor,
  type EventCommandExecutorInput,
} from "../../src/services/event-command-executor.ts";
import * as Events from "../../src/services/event-service.ts";
import * as Tooling from "../../src/services/tooling-engine.ts";
import { planApp } from "../plan-app.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

const serviceType: ServiceType = {
  id: "event-literals",
  name: "event-literals",
  base: "l337",
  schema: Schema.Unknown,
  resolve: (input) => Effect.succeed({ base: "l337", normalizedConfig: input.service, features: [] }),
};

const fixture = async (source: string, hostEvents: HostEvents = {}) => {
  const root = await mkdtemp(join(tmpdir(), "lando-event-literals-"));
  const file = join(root, ".lando.yml");
  await writeFile(join(root, "payload.txt"), "{{ env.CANARY }} ${secret:CANARY}");
  await writeFile(
    file,
    `name: event-literals\nservices:\n  web:\n    type: ${serviceType.id}\n    home: false\n${source}`,
  );
  const loaded = await Effect.runPromise(
    loadLandofileFile(file, {
      appRoot: root,
      layer: "canonical",
      policy: DEFAULT_LANDOFILE_LOAD_POLICY,
      pendingSites: [],
      compilationContext: { appRoot: AbsolutePath.make(root), env: { CANARY: "captured-canary" } },
    }),
  );
  const config = Schema.decodeUnknownSync(GlobalConfig)({ hostEvents });
  const plan = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;
      return yield* planApp(
        { landofile: loaded, providerCapabilities: TestRuntimeProvider.capabilities },
        Layer.mergeAll(
          Layer.succeed(PluginRegistry, { ...registry, loadServiceType: () => Effect.succeed(serviceType) }),
          Layer.succeed(
            ConfigService,
            ConfigService.of({ load: Effect.succeed(config), get: (key) => Effect.succeed(config[key]) }),
          ),
        ),
      );
    }).pipe(Effect.provide(Registry.layerWith({ bundled: false }, []))),
  );
  const specs: CommandSpec[] = [];
  const canonical: EventCommandExecutorInput[] = [];
  const reads: string[] = [];
  const provider = {
    ...TestRuntimeProvider,
    execStream: (_target: ExecTarget, spec: CommandSpec) =>
      Stream.suspend(() => {
        specs.push(spec);
        return Stream.make({ exitCode: 0 });
      }),
  };
  const security = Layer.mergeAll(
    Layer.succeed(RedactionService, makeRedactionService()),
    Layer.succeed(SecretStore, {
      id: "event-literals",
      get: (key) => Effect.sync(() => reads.push(key)).pipe(Effect.as("secret-canary")),
      has: (key) => Effect.sync(() => reads.push(`has:${key}`)).pipe(Effect.as(true)),
      list: Effect.sync(() => reads.push("list")).pipe(Effect.as([])),
    }),
  );
  const resolver = Resolver.layer.pipe(Layer.provideMerge(security));
  const runtime = Layer.mergeAll(
    Events.layer,
    Layer.succeed(PrivateFileAccessService, ownerOnlyFileAccess),
    resolver,
    Layer.succeed(RuntimeProviderRegistry, {
      appliedPlansFor: () => Effect.succeed([]),
      resolveAppliedPlan: () => Effect.succeed(undefined),
      resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" }),
      list: Effect.succeed([plan.provider]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    }),
    Tooling.layer.pipe(Layer.provide(resolver)),
    Layer.succeed(EventCommandExecutor, {
      validate: () => Effect.void,
      run: (input) =>
        Effect.sync(() => canonical.push(input)).pipe(Effect.as({ exitCode: 0, stdout: "", stderr: "" })),
    }),
  );
  return {
    plan,
    runtime,
    specs,
    reads,
    canonical,
    close: () => rm(root, { recursive: true, force: true }),
    event: (app: AppPlan = plan) =>
      Effect.runPromise(
        runAppEvent(app, "pre-start", { CANARY: "runtime-canary" }).pipe(Effect.provide(runtime)),
      ),
    direct: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const task = effectiveToolingForPlan(plan)?.check;
          if (task === undefined) return yield* Effect.die("missing check task");
          const compiled = yield* Invocation.compileToolingInvocations({
            name: "check",
            lookupKey: "check",
            task,
            source: { path: file, task: "check" },
          });
          return yield* Invocation.executeToolingInvocations({
            plan,
            tool: "check",
            invocations: compiled.invocations,
            requiresProvider: true,
          });
        }).pipe(Effect.provide(runtime)),
      ),
  };
};

test.each([
  ["{{{{ env.CANARY }}", "{{ env.CANARY }}"],
  ["{{{{ event.CANARY }}", "{{ event.CANARY }}"],
  ["$${secret:CANARY}", "${secret:CANARY}"],
  ["{{ load('./payload.txt') }}", "{{ env.CANARY }} ${secret:CANARY}"],
] as const)(
  "keeps compiled task bytes identical in direct and event execution: %s",
  async (authored, literal) => {
    // Given a real compiled task and an event referencing it.
    const h = await fixture(
      `tooling:\n  check:\n    cmd: ${JSON.stringify(authored)}\nevents:\n  pre-start:\n    - task: check`,
    );
    try {
      // When both entrypoints execute through the fake provider.
      await h.direct();
      await h.event();
      await h.event({ ...h.plan, extensions: JSON.parse(JSON.stringify(h.plan.extensions)) });
      // Then neither entrypoint interprets the semantic task again.
      expect(h.specs.map((spec) => spec.command[2])).toEqual(Array(3).fill(`${literal} "$@"`));
      expect(h.reads).toEqual([]);
    } finally {
      await h.close();
    }
  },
);

test("keeps project cmd, defer, task vars and canonical inputs inert", async () => {
  // Given escaped and loaded strings at each compiled event leaf boundary.
  const h = await fixture(`tooling:
  check:
    cmd: echo check
events:
  pre-start:
    - cmd: "{{{{ env.CANARY }}"
      env:
        TOKEN: "$\u0024{secret:CANARY}"
    - task: check
      vars:
        value: "{{{{ env.CANARY }}"
    - command: info
      flags:
        literal: "{{{{ broken"
        tags: ["{{ load('./payload.txt') }}"]
      args:
        value: "{{{{ env.CANARY }}"
      raw: ["$\u0024{secret:CANARY}"]
    - defer: "{{ load('./payload.txt') }}"`);
  try {
    // When the compiled event runs.
    await h.event();
    // Then all executable bytes and canonical input data retain their literal meaning.
    expect(h.specs.map((spec) => spec.command[2])).toEqual([
      '{{ env.CANARY }} "$@"',
      'echo check "$@"',
      '{{ env.CANARY }} ${secret:CANARY} "$@"',
    ]);
    expect(h.specs[0]?.env?.TOKEN).toBe("${secret:CANARY}");
    expect(h.canonical[0]).toMatchObject({
      flags: { literal: "{{ broken", tags: ["{{ env.CANARY }} ${secret:CANARY}"] },
      args: { value: "{{ env.CANARY }}" },
      argv: ["${secret:CANARY}"],
    });
    expect(h.reads).toEqual([]);
  } finally {
    await h.close();
  }
});

test("retains authored host expressions while project expressions use captured context", async () => {
  // Given an authored GLOBAL host event and an already-compiled project expression.
  const h = await fixture('events:\n  pre-start:\n    - cmd: "{{ env.CANARY }}"', {
    "pre-start": [{ command: "{{ event.CANARY }}" }],
  });
  try {
    // When the event receives runtime context.
    await h.event();
    // Then only the authored host expression consumes it.
    expect(h.canonical[0]?.command).toBe("runtime-canary");
    expect(h.specs[0]?.command[2]).toBe('captured-canary "$@"');
    expect(h.reads).toEqual([]);
  } finally {
    await h.close();
  }
});

test("rejects an inert compiled condition instead of evaluating it against runtime context", async () => {
  // Given a literal condition string that would become true if reparsed.
  const h = await fixture(
    "events:\n  pre-start:\n    - cmd: echo forbidden\n      if: \"{{{{ event.CANARY == 'runtime-canary' }}\"",
  );
  try {
    // When the event executes with the matching runtime context.
    const error = await Effect.runPromise(
      runAppEvent(h.plan, "pre-start", { CANARY: "runtime-canary" }).pipe(
        Effect.provide(h.runtime),
        Effect.flip,
      ),
    );
    expect(error).toMatchObject({
      _tag: "LandofileEventStepFailedError",
      index: 0,
      outputTail: "Compiled event step condition must be a boolean.",
    });
    // Then no command or secret lookup occurs.
    expect(h.specs).toEqual([]);
    expect(h.reads).toEqual([]);
  } finally {
    await h.close();
  }
});
