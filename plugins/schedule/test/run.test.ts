import { describe, expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  AppPlan,
  LoadScopedLandofile,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import {
  LandofileService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  ToolingEngine,
  type ToolingInvocation,
} from "@lando/sdk/services";
import { DateTime, Effect, Layer } from "effect";

import { spec } from "../src/commands/run.ts";
import { ScheduleJobAmbiguousError, ScheduleJobNotFoundError } from "../src/errors.ts";
import { runScheduleJob } from "../src/run-job.ts";

const appRoot = AbsolutePath.make("/tmp/schedule-run");

const landofile = LoadScopedLandofile.make({
  stage: "load-scoped",
  pendingSites: [],
  context: { appRoot, env: {} },
  document: {
    name: "demo",
    services: {
      [ServiceName.make("web")]: {
        type: "compose",
        schedule: [
          { name: "ok", every: "@yearly", run: "echo ok" },
          { name: "argv", every: "@yearly", run: ["echo", "ok"] },
          { name: "fail", every: "@yearly", run: "exit 3", user: "1002" },
          { name: "dup", every: "@yearly", run: "true" },
        ],
      },
      [ServiceName.make("db")]: {
        type: "compose",
        schedule: [{ name: "dup", every: "@yearly", run: "true" }],
      },
    },
  },
});

const plan = AppPlan.make({
  id: AppId.make("demo"),
  name: "demo",
  slug: "demo",
  root: appRoot,
  provider: ProviderId.make("lando"),
  services: {},
  routes: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.makeUnsafe("2026-11-03T12:00:00Z"),
    source: "run.test",
    runtime: 4,
  },
  extensions: {},
});

const provider = {} as RuntimeProviderShape;

const makeRuntime = (options: { readonly applied?: boolean } = {}) => {
  const invocations: ToolingInvocation[] = [];
  const tooling = ToolingEngine.of({
    id: "test",
    run: (invocation) => {
      invocations.push(invocation);
      const command = invocation.commands[0]?.join(" ") ?? "";
      const failed = command.includes("exit 3");
      return Effect.succeed({
        tool: invocation.tool,
        service: invocation.service ?? "web",
        exitCode: failed ? 3 : 0,
        stdout: "job-stdout\n",
        stderr: failed ? "job-stderr\n" : "",
      });
    },
  });
  const registry = RuntimeProviderRegistry.of({
    list: Effect.succeed([]),
    capabilities: Effect.die("unused"),
    appliedPlansFor: () => Effect.die("unused"),
    select: () => Effect.succeed(provider),
    resolveAppliedPlan: () => Effect.succeed(options.applied === false ? undefined : plan),
    resolveTeardownEvidence: () => Effect.die("unused"),
  });
  const layer = Layer.mergeAll(
    Layer.succeed(LandofileService, LandofileService.of({ discover: Effect.succeed(landofile) })),
    Layer.succeed(RuntimeProviderRegistry, registry),
    Layer.succeed(ToolingEngine, tooling),
  );
  return {
    invocations,
    run: (name: string, service?: string) =>
      Effect.runPromise(
        runScheduleJob({ name, ...(service === undefined ? {} : { service }) }).pipe(Effect.provide(layer)),
      ),
  };
};

describe("schedule:run", () => {
  test("returns the completed result and classifies a nonzero exit through completion", async () => {
    const runtime = makeRuntime();
    const result = await runtime.run("fail");
    expect(result).toEqual({
      service: "web",
      name: "fail",
      exitCode: 3,
      stdout: "job-stdout\n",
      stderr: "job-stderr\n",
    });
    expect(spec.completion?.(result)).toEqual({ ok: false, exitCode: 3 });

    const success = await runtime.run("ok");
    expect(success.exitCode).toBe(0);
    expect(spec.completion?.(success)).toEqual({ ok: true, exitCode: 0 });
  });

  test("forwards the job user and the resolved argv into the tooling invocation", async () => {
    const runtime = makeRuntime();
    await runtime.run("ok");
    const inherit = runtime.invocations[0];
    expect(inherit?.tool).toBe("schedule:run");
    expect(inherit?.service).toBe("web");
    expect(inherit === undefined || "user" in inherit).toBe(false);
    expect(inherit?.commands).toEqual([["sh", "-c", "echo ok"]]);

    await runtime.run("argv");
    expect(runtime.invocations[1]?.commands).toEqual([["echo", "ok"]]);

    await runtime.run("fail");
    expect(runtime.invocations[2]?.user).toBe("1002");
    expect(runtime.invocations[2]?.commands).toEqual([["sh", "-c", "exit 3"]]);
  });

  test("fails with the not-found and ambiguous errors before touching the provider", async () => {
    const runtime = makeRuntime();
    await expect(runtime.run("missing")).rejects.toBeInstanceOf(ScheduleJobNotFoundError);
    await expect(runtime.run("dup")).rejects.toBeInstanceOf(ScheduleJobAmbiguousError);
    const scoped = await runtime.run("dup", "web");
    expect(scoped.service).toBe("web");
    expect(runtime.invocations).toHaveLength(1);
    expect(runtime.invocations[0]?.service).toBe("web");
  });
});
