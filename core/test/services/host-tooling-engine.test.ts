import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, DateTime, Effect, Exit } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { type RuntimeProviderShape, ToolingEngine, type ToolingInvocation } from "@lando/sdk/services";

import {
  HostToolingEngineLive,
  evaluateHostVar,
  resolveScriptPath,
  runHostScript,
} from "../../src/services/host-tooling-engine.ts";

const providerId = ProviderId.make("lando");

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-18T00:00:00Z"),
  source: "host-tooling-engine.test",
  runtime: 4 as const,
};

const stubCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: false,
  serviceExec: false,
  serviceLogs: false,
  serviceHealth: "none" as const,
  hostReachability: "none" as const,
  sharedCrossAppNetwork: false,
  persistentStorage: false,
  bindMounts: false,
  bindMountPerformance: "none" as const,
  copyMounts: false,
  copyOnWriteAppRoot: false,
  volumeSnapshot: "none",
  serviceFileCopy: "none",
  artifactExport: false,
  artifactImport: false,
  ephemeralMounts: false,
  hostPortPublish: "none" as const,
  routeProvider: false,
  tlsCertificates: "none" as const,
  rootless: true,
  privilegedServices: false,
  composeSpec: "none" as const,
  providerExtensions: [],
};

const baseServicePlan = (name: string, primary = false): ServicePlan => ({
  name: ServiceName.make(name),
  type: "node",
  provider: providerId,
  primary,
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const makePlan = (services: ReadonlyArray<ServicePlan>): AppPlan => {
  const map: Record<string, ServicePlan> = {};
  for (const service of services) map[service.name] = service;
  return {
    id: AppId.make("host-engine-test"),
    name: "host-engine-test",
    slug: "host-engine-test",
    root: AbsolutePath.make("/tmp/host-engine-test"),
    provider: providerId,
    services: map as AppPlan["services"],
    routes: [],
    networks: [],
    stores: [],
    metadata,
    extensions: {},
  };
};

const stubProvider: RuntimeProviderShape = {
  id: providerId,
  displayName: "Stub for host engine",
  version: "0.0.0",
  platform: "linux",
  capabilities: stubCapabilities,
  isAvailable: Effect.succeed(false),
  setup: () => Effect.void,
  getStatus: Effect.succeed({ running: false }),
  getVersions: Effect.succeed({ provider: "0.0.0" }),
  buildArtifact: () => Effect.die("stub"),
  pullArtifact: () => Effect.die("stub"),
  removeArtifact: () => Effect.void,
  apply: () => Effect.succeed({ changed: false }),
  start: () => Effect.void,
  stop: () => Effect.void,
  restart: () => Effect.void,
  destroy: () => Effect.void,
  exec: () => Effect.die("host engine must not call provider exec"),
  execStream: () => Effect.die("stub") as never,
  run: () => Effect.die("stub"),
  logs: () => Effect.die("stub") as never,
  inspect: () => Effect.die("stub"),
  list: () => Effect.succeed([]),
};

const runEngine = (invocation: ToolingInvocation, plan: AppPlan) =>
  Effect.flatMap(ToolingEngine, (engine) => engine.run(invocation, plan, stubProvider)).pipe(
    Effect.provide(HostToolingEngineLive),
  );

describe("HostToolingEngineLive", () => {
  test("layer registers engine id 'host'", async () => {
    const engine = await Effect.runPromise(ToolingEngine.pipe(Effect.provide(HostToolingEngineLive)));
    expect(engine.id).toBe("host");
  });

  test("runs a shell command and captures stdout/exitCode", async () => {
    const plan = makePlan([baseServicePlan("web", true)]);
    const invocation: ToolingInvocation = {
      tool: "echo-hi",
      commands: [["sh", "-c", "printf hi"]],
    };

    const result = await Effect.runPromise(runEngine(invocation, plan));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi");
    expect(result.stderr).toBe("");
    expect(result.tool).toBe("echo-hi");
    expect(result.service).toBe(":host");
  });

  test("returns the declared service in the result", async () => {
    const plan = makePlan([baseServicePlan("web", true)]);
    const invocation: ToolingInvocation = {
      tool: "echo-declared",
      service: ":host",
      commands: [["sh", "-c", "printf ok"]],
    };

    const result = await Effect.runPromise(runEngine(invocation, plan));
    expect(result.service).toBe(":host");
  });

  test("propagates non-zero exit codes and stops at first failing command", async () => {
    const plan = makePlan([baseServicePlan("web", true)]);
    const invocation: ToolingInvocation = {
      tool: "fail-then-skip",
      commands: [
        ["sh", "-c", "printf 'first\\n'"],
        ["sh", "-c", "printf 'before-fail\\n' && exit 7"],
        ["sh", "-c", "printf 'never\\n'"],
      ],
    };

    const result = await Effect.runPromise(runEngine(invocation, plan));

    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe("first\nbefore-fail\n");
  });

  test("propagates cwd to the host command", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lando-host-engine-cwd-"));
    try {
      await writeFile(join(cwd, "marker.txt"), "marker-content");
      const plan = makePlan([baseServicePlan("web", true)]);
      const invocation: ToolingInvocation = {
        tool: "read-marker",
        cwd,
        commands: [["sh", "-c", "cat marker.txt"]],
      };

      const result = await Effect.runPromise(runEngine(invocation, plan));

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("marker-content");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("propagates env overrides to the host command", async () => {
    const plan = makePlan([baseServicePlan("web", true)]);
    const invocation: ToolingInvocation = {
      tool: "echo-env",
      env: { LANDO_TEST_HOST_ENV: "from-invocation" },
      commands: [["sh", "-c", 'printf %s "$LANDO_TEST_HOST_ENV"']],
    };

    const result = await Effect.runPromise(runEngine(invocation, plan));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("from-invocation");
  });

  test("fails with ToolingExecError when the invocation has no commands", async () => {
    const plan = makePlan([baseServicePlan("web", true)]);
    const invocation: ToolingInvocation = {
      tool: "empty",
      commands: [],
    };

    const exit = await Effect.runPromiseExit(runEngine(invocation, plan));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value._tag).toBe("ToolingExecError");
        expect(failure.value.tool).toBe("empty");
        expect(failure.value.message).toContain("no commands");
      }
    }
  });

  test("wraps shell launch failures as ToolingExecError carrying a ShellExecError cause", async () => {
    const plan = makePlan([baseServicePlan("web", true)]);
    const invocation: ToolingInvocation = {
      tool: "bad-syntax",
      commands: [["sh", "-c", "echo &&"]],
    };

    const result = await Effect.runPromiseExit(runEngine(invocation, plan));

    if (Exit.isFailure(result)) {
      const failure = Cause.failureOption(result.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value._tag).toBe("ToolingExecError");
        const cause = failure.value.cause as { _tag?: string; command?: string } | undefined;
        expect(cause?._tag).toBe("ShellExecError");
      }
      return;
    }
    expect(result.value.exitCode).not.toBe(0);
    expect(result.value.stderr.length).toBeGreaterThan(0);
  });
});

describe("resolveScriptPath", () => {
  test("returns the realpath when the script is inside a permitted root", async () => {
    const base = await mkdtemp(join(tmpdir(), "lando-host-script-ok-"));
    try {
      const scriptPath = join(base, "task.bun.sh");
      await writeFile(scriptPath, "#!/usr/bin/env bun\nawait Bun.write(Bun.stdout, 'inside');\n");

      const resolved = await Effect.runPromise(resolveScriptPath(scriptPath, [base]));
      expect(resolved.endsWith("task.bun.sh")).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("rejects scripts outside every permitted root with ShellScriptOutsideRootError", async () => {
    const base = await mkdtemp(join(tmpdir(), "lando-host-script-base-"));
    const outside = await mkdtemp(join(tmpdir(), "lando-host-script-out-"));
    try {
      const outsideScript = join(outside, "evil.bun.sh");
      await writeFile(outsideScript, "#!/usr/bin/env bun\nawait Bun.write(Bun.stdout, 'evil');\n");

      const exit = await Effect.runPromiseExit(resolveScriptPath(outsideScript, [base]));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value._tag).toBe("ShellScriptOutsideRootError");
          expect(failure.value.path).toBe(outsideScript);
          expect(failure.value.remediation).toContain("Move the script inside");
        }
      }
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("rejects symlinks that escape the permitted root via realpath", async () => {
    const base = await mkdtemp(join(tmpdir(), "lando-host-script-symlink-base-"));
    const outside = await mkdtemp(join(tmpdir(), "lando-host-script-symlink-out-"));
    try {
      const realScript = join(outside, "target.bun.sh");
      await writeFile(realScript, "#!/usr/bin/env bun\n");

      const symlinkInside = join(base, "linked.bun.sh");
      await symlink(realScript, symlinkInside);

      const exit = await Effect.runPromiseExit(resolveScriptPath(symlinkInside, [base]));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value._tag).toBe("ShellScriptOutsideRootError");
        }
      }
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("rejects with ShellScriptOutsideRootError when no permitted roots are configured", async () => {
    const base = await mkdtemp(join(tmpdir(), "lando-host-script-empty-roots-"));
    try {
      const scriptPath = join(base, "any.bun.sh");
      await writeFile(scriptPath, "#!/usr/bin/env bun\n");

      const exit = await Effect.runPromiseExit(resolveScriptPath(scriptPath, []));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        if (failure._tag === "Some") {
          expect(failure.value._tag).toBe("ShellScriptOutsideRootError");
        }
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("runHostScript", () => {
  test("executes a contained shell script via the host engine", async () => {
    const base = await mkdtemp(join(tmpdir(), "lando-host-run-script-"));
    try {
      const scriptPath = join(base, "say.bun.sh");
      await writeFile(scriptPath, "echo -n 'hello-from-bun-sh'\n");

      const result = await Effect.runPromise(runHostScript(scriptPath, [base]));

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello-from-bun-sh");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("refuses scripts whose realpath escapes the permitted root", async () => {
    const base = await mkdtemp(join(tmpdir(), "lando-host-run-script-base-"));
    const outside = await mkdtemp(join(tmpdir(), "lando-host-run-script-out-"));
    try {
      const evilScript = join(outside, "evil.bun.sh");
      await writeFile(evilScript, "#!/usr/bin/env bun\nawait Bun.write(Bun.stdout, 'evil-output');\n");

      const exit = await Effect.runPromiseExit(runHostScript(evilScript, [base]));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        if (failure._tag === "Some") {
          expect(failure.value._tag).toBe("ShellScriptOutsideRootError");
        }
      }
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("evaluateHostVar", () => {
  test("returns trimmed stdout for a successful expression", async () => {
    const value = await Effect.runPromise(evaluateHostVar("printf 'abc\\n'"));
    expect(value).toBe("abc");
  });

  test("honors cwd when evaluating", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lando-host-var-cwd-"));
    try {
      await writeFile(join(cwd, "marker.txt"), "marker-value");
      const value = await Effect.runPromise(evaluateHostVar("cat marker.txt", { cwd }));
      expect(value).toBe("marker-value");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("fails with ShellExecError when the expression exits non-zero", async () => {
    const exit = await Effect.runPromiseExit(evaluateHostVar("printf 'oh-no' 1>&2; exit 9"));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      if (failure._tag === "Some") {
        expect(failure.value._tag).toBe("ShellExecError");
        expect(failure.value.exitCode).toBe(9);
        expect(failure.value.stderr).toContain("oh-no");
      }
    }
  });
});
