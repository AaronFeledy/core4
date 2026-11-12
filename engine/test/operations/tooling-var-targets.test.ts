import { expect, test } from "bun:test";
import { normalizeToolingTask } from "@lando/landofile/tooling-normalize";
import {
  AbsolutePath,
  AppId,
  type CurrentExecutableAppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import { type CommandSpec, type ExecTarget, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect, Layer, Stream } from "effect";
import { makeDynamicToolingVarResolver } from "../../src/operations/tooling-dynamic-vars.ts";
import { admitToolingTask } from "../../src/operations/tooling-input-admission.ts";
import { HostExecutionDefaults } from "../../src/services/host-execution-context.ts";
import * as ProviderExec from "../../src/services/tooling-engine.ts";
import { testEnvironmentResolverLayer } from "../environment-values.ts";

test.each([":host", "worker"])(
  "explicit container var resets placement from %s in a subdirectory",
  async (service) => {
    const metadata = {
      resolvedAt: DateTime.makeUnsafe("2026-09-12T00:00:00Z"),
      source: "test",
      runtime: 4 as const,
    };
    const plan: CurrentExecutableAppPlan = {
      valueModel: 1,
      id: AppId.make("targets"),
      name: "targets",
      slug: "targets",
      root: AbsolutePath.make("/project"),
      provider: ProviderId.make("test"),
      routes: [],
      fileSync: [],
      stores: [],
      extensions: {},
      metadata,
      services: {
        [ServiceName.make("worker")]: {
          name: ServiceName.make("worker"),
          type: "node",
          provider: ProviderId.make("test"),
          primary: true,
          environment: {},
          mounts: [
            {
              type: "bind",
              source: "/project",
              target: PortablePath.make("/app"),
              role: "app",
              readOnly: false,
              realization: "passthrough",
            },
          ],
          endpoints: [],
          routes: [],
          dependsOn: [],
          hostAliases: [],
          extensions: {},
          metadata,
        },
      },
    };
    const calls: { readonly target: ExecTarget; readonly spec: CommandSpec }[] = [];
    const provider = {
      ...TestRuntimeProvider,
      execStream: (target: ExecTarget, spec: CommandSpec) => {
        calls.push({ target, spec });
        return Stream.make(
          { kind: "stdout" as const, chunk: new TextEncoder().encode("captured") },
          { exitCode: 0 },
        );
      },
    };
    const layer = Layer.mergeAll(
      testEnvironmentResolverLayer,
      ProviderExec.layer.pipe(Layer.provide(testEnvironmentResolverLayer)),
      Layer.succeed(HostExecutionDefaults, { cwd: "/project/subdir", env: {}, platform: "linux" }),
      Layer.succeed(RuntimeProviderRegistry, {
        appliedPlansFor: () => Effect.succeed([]),
        resolveAppliedPlan: () => Effect.succeed(undefined),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
        list: Effect.succeed([plan.provider]),
        capabilities: Effect.succeed(provider.capabilities),
        select: () => Effect.succeed(provider),
      }),
    );
    const task = {
      service,
      user: "task-user",
      dir: PortablePath.make("/task-dir"),
      cmd: "echo body",
      vars: { V: { sh: "compute", service: "worker" } },
    };
    const options = {
      name: "probe",
      lookupKey: "probe",
      task,
      source: { path: ".lando.yml", task: "probe" },
    };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const admitted = yield* admitToolingTask(options);
        const resolver = makeDynamicToolingVarResolver({ plan, options, admitted });
        return yield* resolver({ name: "V", command: "compute", task });
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toBe("captured");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.target.user).toBeUndefined();
    expect(calls[0]?.spec.cwd).toBe("/app/subdir");
    expect(normalizeToolingTask("probe", task)._tag).toBe("Success");
  },
);
