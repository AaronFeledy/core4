import { expect, test } from "bun:test";
import { ConfigExpressionError } from "@lando/sdk/errors";
import type { ExpressionContext } from "@lando/sdk/expressions";
import { AppPlan, LoadScopedLandofile } from "@lando/sdk/schema";
import { PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Schema } from "effect";
import { planApp } from "../../src/planner/assemble.ts";
import { effectiveToolingForPlan } from "../../src/planner/effective-tooling.ts";
import { invocationAuthorityForPlan, sitesUnder } from "../../src/planner/invocation-authority.ts";
import * as Registry from "../../src/plugins/registry.ts";
import { compileEventStepProgram } from "../../src/tooling/step-compiler.ts";
import { resolveToolingTaskShape, runToolingStepProgram } from "../../src/tooling/step-runner.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";

const compile = (document: unknown, env: Readonly<Record<string, string>> = {}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const loaded = yield* compileTestLandofile(document, "/tmp/invocation-authority");
      const registry = yield* PluginRegistry;
      return yield* planApp(
        registry,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        LoadScopedLandofile.make({ ...loaded, context: { ...loaded.context, env } }),
        TestRuntimeProvider.capabilities,
      );
    }).pipe(Effect.provide(Registry.layerWith({ bundled: false }, []))),
  );

const execute = (plan: AppPlan, context: ExpressionContext) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entries = (plan.events?.["pre-start"] ?? []).filter((entry) => entry.status === "active");
      const sites = invocationAuthorityForPlan(plan)?.sites ?? [];
      const commands: unknown[] = [];
      const program = yield* compileEventStepProgram(
        entries.map((entry) => entry.step),
        undefined,
        entries.map((entry) => ({
          authoredIndex: entry.sourceIndex,
          source: entry.source,
          invocationSites: sitesUnder(sites, [
            entry.source === "host" ? "hostEvents" : "events",
            "pre-start",
            entry.sourceIndex,
          ]),
        })),
      );
      yield* runToolingStepProgram(program, context, {
        runCmd: (leaf) => Effect.sync(() => commands.push({ command: leaf.command, env: leaf.env })),
        runCommand: (leaf) =>
          Effect.sync(() => commands.push({ flags: leaf.flags, args: leaf.args, raw: leaf.raw })),
        runTask: (leaf, taskContext) =>
          Effect.gen(function* () {
            const task = effectiveToolingForPlan(plan)?.[leaf.task];
            if (task === undefined) return yield* Effect.die("Missing fixture task");
            const resolved = yield* resolveToolingTaskShape(
              task,
              taskContext,
              sitesUnder(sites, ["tooling", leaf.task]),
            );
            return commands.push({ command: resolved.cmd, env: resolved.env, service: resolved.service });
          }),
        present: () => Effect.void,
      });
      return commands;
    }),
  );

test("distinguishes equal authored runtime text from escaped and helper-produced data", async () => {
  // Given
  const plan = await compile({
    name: "authority",
    tooling: {
      copied: { cmd: "{{ vars.value }}" },
    },
    events: {
      "pre-start": [
        "{{ event.CANARY }}",
        "{{{{ event.CANARY }}",
        "{{ concat('{{ event.', 'CANARY }}') }}",
        { task: "copied", vars: { value: "{{{{ event.CANARY }}" } },
      ],
    },
  });
  // When
  const commands = await execute(plan, { event: { CANARY: "active" } });
  // Then
  expect(commands).toEqual([
    { command: "active", env: undefined },
    { command: "{{ event.CANARY }}", env: undefined },
    { command: "{{ event.CANARY }}", env: undefined },
    { command: "{{ event.CANARY }}", env: undefined, service: undefined },
  ]);
});

test("persists bounded static dependencies and preserves lazy missing paths across JSON roundtrip", async () => {
  // Given
  const plan = await compile(
    {
      name: "authority",
      events: {
        "pre-start": [{ cmd: "{{ event.use ? concat(env.STATIC, '-', event.CANARY) : env.MISSING }}" }],
      },
    },
    { STATIC: "captured", UNRELATED: "must-not-persist" },
  );
  const cached = Schema.decodeUnknownSync(AppPlan)(
    JSON.parse(JSON.stringify(Schema.encodeSync(AppPlan)(plan))),
  );
  // When
  const commands = await execute(cached, { event: { use: true, CANARY: "runtime" } });
  // Then
  expect(commands).toEqual([{ command: "captured-runtime", env: undefined }]);
  expect(cached.events).toEqual(plan.events);
  expect(invocationAuthorityForPlan(cached)).not.toHaveProperty("events");
  expect(JSON.stringify(cached.extensions)).not.toContain("must-not-persist");
});

test("preserves default winners without granting equal overriding literals authority", async () => {
  // Given
  const plan = await compile({
    name: "authority",
    toolingDefaults: {
      env: { VALUE: "{{ event.CANARY }}", COUNT: "{{ event.count }}" },
      vars: { value: "{{ event.CANARY }}" },
    },
    tooling: {
      inherited: { cmd: "{{ vars.value }}" },
      override: {
        cmd: "{{ vars.value }}",
        vars: { value: "{{{{ event.CANARY }}" },
        env: { VALUE: "{{{{ event.CANARY }}" },
      },
    },
    events: { "pre-start": [{ task: "inherited" }, { task: "override" }] },
  });
  // When
  const commands = await execute(plan, { event: { CANARY: "runtime", count: 17 } });
  // Then
  expect(commands).toEqual([
    { command: "runtime", env: { VALUE: "runtime", COUNT: "17" }, service: undefined },
    { command: "{{ event.CANARY }}", env: { VALUE: "{{ event.CANARY }}", COUNT: "17" }, service: undefined },
  ]);
});

test("instantiates predicates and canonical inputs at their recorded sites in loop and defer order", async () => {
  // Given
  const plan = await compile({
    name: "authority",
    events: {
      "pre-start": [
        { defer: "cleanup-{{ item }}", for: ["{{ event.first }}", "b"], if: "{{ event.enabled }}" },
        { cmd: "body-{{ item }}", for: ["{{ event.first }}", "b"], if: "{{ event.enabled }}" },
        {
          command: "info",
          flags: { count: "{{ event.count }}", env: "{{ event.count }}", inert: "{{{{ event.count }}" },
          raw: ["{{ event.CANARY }}"],
        },
      ],
    },
  });
  // When
  const commands = await execute(plan, { event: { enabled: true, count: 17, CANARY: "raw", first: "a" } });
  // Then
  expect(commands).toEqual([
    { command: "body-a", env: undefined },
    { command: "body-b", env: undefined },
    { flags: { count: 17, env: 17, inert: "{{ event.count }}" }, args: {}, raw: ["raw"] },
    { command: "cleanup-b", env: undefined },
    { command: "cleanup-a", env: undefined },
  ]);
});

test("keeps runtime scopes out of service configuration", async () => {
  // Given
  const document = { name: "authority", services: { web: { type: "{{ event.CANARY }}" } } };
  // When
  const result = await Effect.runPromise(compileTestLandofile(document).pipe(Effect.result));
  // Then
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "LandofileValidationError" } });
});

test("lets call vars override an unevaluated missing task default", async () => {
  // Given
  const plan = await compile({
    name: "authority",
    tooling: {
      check: {
        cmd: "{{ vars.value }}",
        vars: { value: "{{ event.missing }}" },
      },
    },
    events: { "pre-start": [{ task: "check", vars: { value: "{{{{ event.CANARY }}" } }] },
  });
  // When
  const commands = await execute(plan, {});
  // Then
  expect(commands).toEqual([{ command: "{{ event.CANARY }}", env: undefined, service: undefined }]);
});

test("captures typed secret bindings in mixed runtime environment expressions", async () => {
  // Given
  const plan = await compile({
    name: "authority",
    events: {
      "pre-start": [
        {
          cmd: "echo",
          env: {
            TOKEN: "prefix-{{ secrets.TOKEN }}-{{ event.suffix }}",
          },
        },
      ],
    },
  });
  // When
  const commands = await execute(
    { ...plan, extensions: JSON.parse(JSON.stringify(plan.extensions)) },
    { event: { suffix: "runtime" } },
  );
  // Then
  expect(commands).toEqual([
    {
      command: "echo",
      env: {
        TOKEN: {
          _tag: "BoundText",
          parts: ["prefix-", { reference: "TOKEN", encoding: "raw" }, "-runtime"],
        },
      },
    },
  ]);
});

test("reports the original mixed expression text for missing runtime values", async () => {
  // Given
  const expression = "prefix {{event.missing}} suffix";
  const plan = await compile({ name: "authority", events: { "pre-start": [expression] } });
  // When
  const error = await execute(plan, {}).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  // Then
  expect(error).toBeInstanceOf(ConfigExpressionError);
  expect(error).toMatchObject({ expression });
});
