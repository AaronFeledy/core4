import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RedactionService } from "@lando/redaction/service";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { ToolingEngine } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { DateTime, Effect, Layer } from "effect";
import { compileToolingInvocations } from "../../src/operations/tooling-compile.ts";
import * as HostToolingEngine from "../../src/services/host-tooling-engine.ts";
import * as ProcessRunner from "../../src/services/process-runner.ts";
import { testEnvironmentResolverLayer } from "../environment-values.ts";

const plan: AppPlan = {
  id: AppId.make("preflight"),
  name: "preflight",
  slug: "preflight",
  root: AbsolutePath.make("/tmp/preflight"),
  provider: ProviderId.make("test"),
  services: {},
  routes: [],
  stores: [],
  fileSync: [],
  extensions: {},
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-05-18T00:00:00Z"), source: "test", runtime: 4 },
};
const layer = HostToolingEngine.layer.pipe(
  Layer.provide(
    Layer.mergeAll(ProcessRunner.layer, PrivateFileAccessService.layer, testEnvironmentResolverLayer),
  ),
);

test.each(["echo ${NAME}", "echo $?", "echo >&2", "echo x >f 2>&1"])(
  "preflights every invocation before admitting a task ending in %s",
  (cmd) => {
    const result = Effect.runSync(
      Effect.result(
        compileToolingInvocations({
          name: "task",
          lookupKey: "task",
          source: { path: "/app/.lando.yml", task: "task" },
          task: {
            cmds: [
              { service: "web", cmd: "touch marker" },
              { service: ":host", cmd },
            ],
          },
        }),
      ),
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingCompileError", tool: "task" } });
  },
);

test.each(["compiled", "direct"] as const)(
  "%s host execution rejects a bad second step without creating the first step's marker",
  async (boundary) => {
    const cwd = await mkdtemp(join(tmpdir(), "lando-host-preflight-"));
    try {
      const result = await Effect.runPromise(
        Effect.result(
          Effect.gen(function* () {
            const engine = yield* ToolingEngine;
            const invocations =
              boundary === "compiled"
                ? (yield* compileToolingInvocations({
                    name: "task",
                    lookupKey: "task",
                    source: { path: "/app/.lando.yml", task: "task" },
                    cwd,
                    task: { service: ":host", cmds: ["echo created >marker", "echo ${NAME}"] },
                  })).invocations
                : [
                    {
                      tool: "task",
                      service: ":host",
                      cwd,
                      commands: [],
                      hostSteps: [
                        { kind: "shell" as const, source: "echo created >marker", argv: [] },
                        { kind: "shell" as const, source: "echo ${NAME}", argv: [] },
                      ],
                    },
                  ];
            return yield* Effect.forEach(invocations, (invocation) =>
              engine.run(invocation, plan, TestRuntimeProvider),
            );
          }).pipe(Effect.provide(layer)),
        ),
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingCompileError" } });
      expect(await Bun.file(join(cwd, "marker")).exists()).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test("accepts literal shell constructs in host argv", () => {
  const compiled = Effect.runSync(
    compileToolingInvocations({
      name: "task",
      lookupKey: "task",
      source: { path: "/app/.lando.yml", task: "task" },
      task: { service: ":host", cmd: ["echo", "${NAME}", "$@"] },
    }),
  );
  expect(compiled.invocations[0]?.hostSteps).toEqual([{ kind: "argv", argv: ["echo", "${NAME}", "$@"] }]);
});

test("redacts sensitive inputs from runtime dialect diagnostics", async () => {
  const result = await Effect.runPromise(
    Effect.result(
      compileToolingInvocations({
        name: "task",
        lookupKey: "task",
        source: { path: "/app/.lando.yml", task: "task" },
        task: { service: ":host", cmd: "echo ${sensitive}", args: { token: { sensitive: true, order: 0 } } },
        input: { _tag: "RawArgv", argv: ["sensitive"] },
      }).pipe(Effect.provide(RedactionService.layer)),
    ),
  );
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingCompileError" } });
  if (result._tag === "Failure") {
    expect(result.failure.message).not.toContain("sensitive");
    expect(result.failure.remediation).not.toContain("sensitive");
  }
});
