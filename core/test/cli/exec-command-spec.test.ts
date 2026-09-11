import { describe, expect, test } from "bun:test";
import { Context, DateTime, Effect, Layer, Stream } from "effect";

import { TestRuntimeProvider, makeTestRuntime } from "@lando/core/testing";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, type RuntimeProviderShape } from "@lando/sdk/services";
import type { BuiltInCommandEntry } from "../../src/cli/built-in-command-registry.ts";
import { execSpec } from "../../src/cli/command-specs/app/exec.ts";
import { makeEventCommandExecutor } from "../../src/cli/event-command-executor.ts";

const providerId = ProviderId.make("test");
const serviceName = ServiceName.make("appserver");
const runtimeTag = Context.GenericTag<unknown>("exec-command-spec/runtime");
const plan: AppPlan = {
  id: AppId.make("exec-command-spec"),
  name: "exec-command-spec",
  slug: "exec-command-spec",
  root: AbsolutePath.make("/test-runtime/app"),
  provider: providerId,
  services: {
    [serviceName]: {
      name: serviceName,
      type: "node",
      provider: providerId,
      primary: true,
      environment: {},
      mounts: [],
      storage: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata: {
        resolvedAt: DateTime.unsafeMake("2026-09-11T00:00:00Z"),
        source: "exec-command-spec.test",
        runtime: 4,
      },
      extensions: {},
    },
  },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-09-11T00:00:00Z"),
    source: "exec-command-spec.test",
    runtime: 4,
  },
  extensions: {},
};

describe("exec command spec", () => {
  test.each([
    { name: "one-shot default", interactive: false, expectedStdin: undefined },
    { name: "explicit interactive input", interactive: true, expectedStdin: "inherit" },
  ] as const)("routes $name to provider exec", async ({ interactive, expectedStdin }) => {
    // Given
    const stdinModes: Array<"inherit" | "ignore" | undefined> = [];
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      execStream: (_target, command) => {
        stdinModes.push(command.stdin);
        return Stream.fromIterable([{ exitCode: 0 }]);
      },
    };
    const runtime = makeTestRuntime({ bootstrap: "app", with: { RuntimeProvider: provider } });
    const entry: BuiltInCommandEntry = { spec: execSpec, status: { kind: "implemented" } };

    // When
    await Effect.runPromise(
      Effect.scoped(
        Layer.build(runtime.layer).pipe(
          Effect.map((context) =>
            Context.add(
              Context.add(context, AppPlanner, { plan: () => Effect.succeed(plan) }),
              runtimeTag,
              {},
            ),
          ),
          Effect.flatMap((context) =>
            makeEventCommandExecutor(context, [entry]).run({
              command: execSpec.id,
              flags: { interactive },
              args: { command: "cat" },
              argv: [],
              cwd: process.cwd(),
            }),
          ),
        ),
      ),
    );

    // Then
    expect(stdinModes).toEqual([expectedStdin]);
  });
});
