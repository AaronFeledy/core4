import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { compileInvocationSites } from "@lando/landofile/compiled-sites";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import {
  AbsolutePath,
  AppId,
  type CurrentExecutableAppPlan,
  ProviderId,
  type ToolingTaskShape,
} from "@lando/sdk/schema";
import {
  ProcessRunner,
  RuntimeProviderRegistry,
  ShellRunner,
  ToolingEngine,
  type ToolingInvocation,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect, Layer } from "effect";
import {
  compileToolingInvocations,
  executeToolingInvocations,
} from "../../src/operations/tooling-compile.ts";
import { admitToolingTask } from "../../src/operations/tooling-input-admission.ts";
import { prepareToolingInvocation } from "../../src/operations/tooling-prepare.ts";
import { sitesUnder } from "../../src/planner/invocation-authority.ts";
import * as Resolver from "../../src/services/environment-value-resolver.ts";
import * as BunProcessRunner from "../../src/services/process-runner.ts";
import * as EnvSecretStore from "../../src/services/secret-store.ts";
import { makeShellRunnerService } from "../../src/services/shell-runner.ts";
import { compileEventStepProgram } from "../../src/tooling/step-compiler.ts";
import { resolveToolingTaskShape, runToolingStepProgram } from "../../src/tooling/step-runner.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

const ROOT = "/tmp/lando-secret-bindings";
const SOURCE = { path: `${ROOT}/.lando.yml`, task: "deploy" };
const SECRET_A = "secret value with two  spaces *";
const SECRET_B = "second secret *";

const plan: CurrentExecutableAppPlan = {
  valueModel: 1,
  id: AppId.make("secret-bindings"),
  name: "secret-bindings",
  slug: "secret-bindings",
  root: AbsolutePath.make(ROOT),
  provider: ProviderId.make("test"),
  services: {},
  routes: [],
  fileSync: [],
  stores: [],
  extensions: {},
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-09-12T00:00:00Z"), source: "test", runtime: 4 },
};

const load = async (document: unknown) => {
  const compiled = await Effect.runPromise(
    loadAuthoredDocuments([{ file: SOURCE.path, value: document }], { appRoot: ROOT, file: SOURCE.path }),
  );
  const sites = await Effect.runPromise(compileInvocationSites(compiled.pendingSites, {}, compiled.document));
  return { document: compiled.document, sites };
};

const taskOf = (
  document: Awaited<ReturnType<typeof load>>["document"],
  name = "deploy",
): ToolingTaskShape => {
  const task = document.tooling?.[name];
  if (task === undefined) throw new Error(`expected tooling.${name}`);
  return task;
};

const resolveTask = async (loaded: Awaited<ReturnType<typeof load>>, name = "deploy", context = {}) =>
  Effect.runPromise(
    resolveToolingTaskShape(
      taskOf(loaded.document, name),
      context,
      sitesUnder(loaded.sites, ["tooling", name]),
    ),
  );

const runner = Effect.runSync(ProcessRunner.pipe(Effect.provide(BunProcessRunner.layer)));

const registry = RuntimeProviderRegistry.of({
  appliedPlansFor: () => Effect.succeed([]),
  resolveAppliedPlan: () => Effect.succeed(undefined),
  resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
  list: Effect.succeed([plan.provider]),
  capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
  select: () => Effect.succeed(TestRuntimeProvider),
});

const layers = (engine: ToolingEngine["Service"], redaction = makeRedactionService()) =>
  Layer.mergeAll(
    BunProcessRunner.layer,
    Resolver.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          EnvSecretStore.layerWith({ env: { LANDO_SECRET_A: SECRET_A, LANDO_SECRET_B: SECRET_B } }),
          Layer.succeed(RedactionService, redaction),
        ),
      ),
    ),
    Layer.succeed(
      ShellRunner,
      makeShellRunnerService(
        () => {
          throw new Error("unused REPL");
        },
        ownerOnlyFileAccess,
        runner,
      ),
    ),
    Layer.succeed(ToolingEngine, engine),
    Layer.succeed(RuntimeProviderRegistry, registry),
  );

const hostEngine = ToolingEngine.of({ id: "unused", run: () => Effect.die("host only") });

const containerEngine = (seen: Array<ToolingInvocation>) =>
  ToolingEngine.of({
    id: "recording",
    run: (invocation) =>
      Effect.sync(() => {
        seen.push(invocation);
        return {
          tool: invocation.tool,
          service: invocation.service ?? "",
          exitCode: 0,
          stdout: typeof invocation.env?.TOKEN === "string" ? invocation.env.TOKEN : "",
          stderr: "",
        };
      }),
  });

const prepare = (
  loaded: Awaited<ReturnType<typeof load>>,
  name: string,
  engine: ToolingEngine["Service"],
  redaction = makeRedactionService(),
  task = taskOf(loaded.document, name),
  env?: import("@lando/sdk/schema").Environment,
) =>
  Effect.runPromise(
    Effect.result(
      prepareToolingInvocation({
        plan,
        options: {
          name,
          lookupKey: name,
          task,
          source: { ...SOURCE, task: name },
          ...(env === undefined ? {} : { env }),
        },
        sites: sitesUnder(loaded.sites, ["tooling", name]),
      }).pipe(Effect.provide(layers(engine, redaction))),
    ),
  );

const compileResolved = async (loaded: Awaited<ReturnType<typeof load>>, name = "deploy") => {
  const resolved = await resolveTask(loaded, name);
  const admitted = await Effect.runPromise(
    admitToolingTask({
      name,
      task: resolved.task,
      source: { ...SOURCE, task: name },
      sites: sitesUnder(loaded.sites, ["tooling", name]),
    }),
  );
  return Effect.runPromise(
    compileToolingInvocations({
      name,
      lookupKey: name,
      task: resolved.task,
      bindings: resolved.bindings,
      source: { ...SOURCE, task: name },
      admitted,
    }),
  );
};

test("a caller env that already sets the generated name to another value is refused", async () => {
  // Given a caller-supplied env that claims the name Lando generates for secret A.
  const loaded = await load({ name: "probe", tooling: { deploy: { cmd: "printf '%s' ${secret:A}" } } });
  const resolved = await resolveTask(loaded, "deploy");
  const sites = sitesUnder(loaded.sites, ["tooling", "deploy"]);
  const admitted = await Effect.runPromise(
    admitToolingTask({ name: "deploy", task: resolved.task, source: { ...SOURCE, task: "deploy" }, sites }),
  );
  const name = `LANDO_BOUND_SECRET_${createHash("sha256").update("A").digest("hex").slice(0, 16)}`;
  // When
  const result = await Effect.runPromise(
    Effect.result(
      compileToolingInvocations({
        name: "deploy",
        lookupKey: "deploy",
        task: resolved.task,
        bindings: resolved.bindings,
        source: { ...SOURCE, task: "deploy" },
        admitted,
        env: { [name]: "caller value" },
      }),
    ),
  );
  // Then
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ToolingCompileError", message: expect.stringContaining(name) },
  });
});

test.each([
  ["cmd", { cmd: "printf '%s' ${secret:A}" }],
  ["shorthand", "printf '%s' ${secret:A}"],
  ["cmds", { cmds: ["printf '%s' ${secret:A}", "echo plain"] }],
] as const)("a task %s carries its binding only on the step that uses it", async (_label, task) => {
  // Given
  const loaded = await load({ name: "probe", tooling: { deploy: task } });
  // When
  const compiled = await compileResolved(loaded);
  // Then
  const envs = compiled.invocations.map((invocation) => invocation.env ?? {});
  expect(envs).toHaveLength(_label === "cmds" ? 2 : 1);
  expect(Object.values(envs[0] ?? {})[0]).toMatchObject({ _tag: "SecretRef", reference: "A" });
  expect(Object.keys(envs[0] ?? {})).toHaveLength(1);
  if (envs.length > 1) expect(envs[1]).toEqual({});
});

test("an event cmd leaf receives its binding and its resolution registers redaction", async () => {
  // Given
  const loaded = await load({
    name: "probe",
    events: { "post-start": [{ service: ":host", cmd: "printf '%s' ${secret:A}" }] },
  });
  const steps = loaded.document.events?.["post-start"] ?? [];
  const identity = {
    authoredIndex: 0,
    invocationSites: sitesUnder(loaded.sites, ["events", "post-start", 0]),
  };
  const program = await Effect.runPromise(compileEventStepProgram(steps, undefined, [identity]));
  const lowered: Array<{ command: string; env: unknown }> = [];
  // When
  await Effect.runPromise(
    runToolingStepProgram(
      program,
      {},
      {
        runCmd: (leaf) =>
          Effect.sync(() => {
            lowered.push({ command: leaf.command, env: leaf.env });
          }),
        runCommand: () => Effect.die("unexpected command"),
        runTask: () => Effect.die("unexpected task"),
        present: () => Effect.void,
      },
    ),
  );
  // Then
  expect(lowered).toHaveLength(1);
  const binding = Object.entries((lowered[0]?.env ?? {}) as Record<string, { _tag: string }>)[0];
  expect(binding?.[1]).toMatchObject({ _tag: "SecretRef", reference: "A" });
  expect(lowered[0]?.command).toContain(binding?.[0] ?? "<missing>");

  const redaction = makeRedactionService();
  const prepared = await prepare(
    loaded,
    "post-start",
    hostEngine,
    redaction,
    { cmd: lowered[0]?.command ?? "", service: ":host" },
    lowered[0]?.env as import("@lando/sdk/schema").Environment | undefined,
  );
  expect(prepared).toMatchObject({ _tag: "Success" });
  if (prepared._tag === "Failure") return;
  await Effect.runPromise(
    Effect.scoped(
      executeToolingInvocations({
        plan,
        tool: "post-start",
        invocations: prepared.success.invocations,
        requiresProvider: false,
      }).pipe(Effect.provide(layers(hostEngine, redaction))),
    ),
  );
  const redactor = await Effect.runPromise(redaction.forProfile("secrets"));
  expect(redactor.redactString(SECRET_A)).toContain("[redacted]");
});

test("a var sh with its own env reaches a host command with both bindings", async () => {
  // Given
  const loaded = await load({
    name: "probe",
    tooling: {
      deploy: {
        service: ":host",
        cmd: "printf '[%s]' {{ vars.T }}",
        vars: { T: { sh: 'printf "%s-%s" ${secret:A} "$TOKEN"', env: { TOKEN: "${secret:B}" } } },
      },
    },
  });
  // When
  const prepared = await prepare(loaded, "deploy", hostEngine);
  // Then
  expect(prepared).toMatchObject({ _tag: "Success" });
  if (prepared._tag === "Failure") return;
  expect(prepared.success.normalized.steps[0]?.cmd).toContain(`${SECRET_A}-${SECRET_B}`);
});

test("a container var command receives its authored secret env", async () => {
  // Given
  const seen: Array<ToolingInvocation> = [];
  const loaded = await load({
    name: "probe",
    tooling: {
      deploy: {
        service: "app",
        cmd: "printf '[%s]' {{ vars.T }}",
        vars: { T: { sh: 'printf "%s" "$TOKEN"', env: { TOKEN: "${secret:B}" } } },
      },
    },
  });
  // When
  const prepared = await prepare(loaded, "deploy", containerEngine(seen));
  // Then
  expect(prepared).toMatchObject({ _tag: "Success" });
  const varInvocation = seen.find((invocation) =>
    invocation.commands.some((argv) => argv.some((part) => part.includes('printf "%s"'))),
  );
  expect(varInvocation?.env).toMatchObject({ TOKEN: SECRET_B });
});

test("a var sh without env has no generated binding on the var command", async () => {
  // Given
  const seen: Array<ToolingInvocation> = [];
  const loaded = await load({
    name: "probe",
    tooling: {
      deploy: { service: "app", cmd: "echo plain", vars: { T: { sh: 'printf "%s" "$TOKEN"' } } },
    },
  });
  // When
  const prepared = await prepare(loaded, "deploy", containerEngine(seen));
  // Then
  const varInvocation = seen.find((invocation) =>
    invocation.commands.some((argv) => argv.some((part) => part.includes('printf "%s"'))),
  );
  expect(prepared).toMatchObject({ _tag: "Success" });
  expect(seen).toHaveLength(1);
  expect(varInvocation).toBeDefined();
  expect(varInvocation?.env).toBeUndefined();
});

test("a var env value that reads a dynamic var is refused", async () => {
  // Given
  const loaded = await load({
    name: "probe",
    tooling: {
      deploy: {
        cmd: "echo {{ vars.A }}",
        vars: {
          A: { sh: "echo one" },
          B: { sh: "echo two", env: { X: "{{ vars.A }}" } },
        },
      },
    },
  });
  // When
  const prepared = await prepare(loaded, "deploy", hostEngine);
  // Then
  expect(prepared).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ToolingCompileError", message: expect.stringContaining("Dynamic tooling vars") },
  });
});

test("a reserved LANDO key in a var env is refused", async () => {
  // Given
  const loaded = await load({
    name: "probe",
    tooling: {
      deploy: { cmd: "echo plain", vars: { T: { sh: "echo value", env: { LANDO_TOKEN: "x" } } } },
    },
  });
  // When
  const prepared = await prepare(loaded, "deploy", hostEngine);
  // Then
  expect(prepared).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ToolingCompileError", message: expect.stringContaining("LANDO_TOKEN") },
  });
});

test("a higher layer that replaces the command leaves no binding behind", async () => {
  // Given
  const compiled = await Effect.runPromise(
    loadAuthoredDocuments(
      [
        {
          file: `${ROOT}/.lando.yml`,
          value: { name: "probe", tooling: { deploy: { cmd: "echo ${secret:A}" } } },
        },
        { file: `${ROOT}/.lando.local.yml`, value: { tooling: { deploy: { cmd: "echo replaced" } } } },
      ],
      { appRoot: ROOT, file: `${ROOT}/.lando.yml` },
    ),
  );
  // When
  const sites = await Effect.runPromise(compileInvocationSites(compiled.pendingSites, {}, compiled.document));
  const resolved = await Effect.runPromise(
    resolveToolingTaskShape(taskOf(compiled.document), {}, sitesUnder(sites, ["tooling", "deploy"])),
  );
  // Then
  expect(compiled.pendingSites.filter((site) => site.path[0] === "tooling")).toEqual([]);
  expect([...resolved.bindings.commands.keys()]).toEqual([]);
  expect(resolved.task.cmd).toBe("echo replaced");
});
