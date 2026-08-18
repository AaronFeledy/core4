import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, type Context, DateTime, Effect, Exit } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import {
  type RuntimeProviderShape,
  type ShellCommandOptions,
  type ShellRunner,
  ToolingEngine,
  type ToolingInvocation,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import {
  HostToolingEngineLive,
  evaluateHostVar,
  resolveScriptPath,
  runHostScript,
  runHostToolingWith,
} from "../../src/services/host-tooling-engine";

const providerId = ProviderId.make("lando");

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-18T00:00:00Z"),
  source: "host-tooling-engine.test",
  runtime: 4 as const,
};

const stubCapabilities: ProviderCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: false,
  serviceExec: false,
  serviceLogs: false,
  serviceLogSources: false,
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
    fileSync: [],
    metadata,
    extensions: {},
  };
};

const stubProvider: RuntimeProviderShape = {
  ...TestRuntimeProvider,
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
  waitForExit: () => Effect.succeed({ exitCode: 0 }),
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

type ShellExecCall = {
  readonly source: string;
  readonly argv: ReadonlyArray<string>;
};

const makeRecordingShell = (): {
  readonly shell: Context.Tag.Service<typeof ShellRunner>;
  readonly calls: () => ReadonlyArray<ShellExecCall>;
} => {
  const calls: ShellExecCall[] = [];
  const shell: Context.Tag.Service<typeof ShellRunner> = {
    exec: (source: string, options?: ShellCommandOptions) =>
      Effect.sync(() => {
        calls.push({ source, argv: options?.argv ?? [] });
        return { exitCode: 0, stdout: "recorded", stderr: "" };
      }),
    run: (source, options) => shell.exec(source, options),
    runScript: () => Effect.die("not used"),
    interactive: () => Effect.die("not used"),
  };
  return { shell, calls: () => calls };
};

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
      hostSteps: [{ kind: "shell", source: "printf hi", argv: [] }],
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
      hostSteps: [{ kind: "shell", source: "printf ok", argv: [] }],
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
      hostSteps: [
        { kind: "shell", source: "printf 'first\\n'", argv: [] },
        { kind: "shell", source: "printf 'before-fail\\n' && exit 7", argv: [] },
        { kind: "shell", source: "printf 'never\\n'", argv: [] },
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
        hostSteps: [{ kind: "shell", source: "cat marker.txt", argv: [] }],
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
      hostSteps: [{ kind: "shell", source: 'printf %s "$LANDO_TEST_HOST_ENV"', argv: [] }],
    };

    const result = await Effect.runPromise(runEngine(invocation, plan));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("from-invocation");
  });

  test("fails closed when the invocation has no structural host steps", async () => {
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
        if (failure.value._tag === "ToolingExecError") {
          expect(failure.value.tool).toBe("empty");
          expect(failure.value.message).toContain("structural host steps");
        }
      }
    }
  });

  test("decodes commands-only normalized sh -c arrays into structural shell without spawning sh", async () => {
    // Given a legacy commands form with the lando-tooling marker and appended $@ sentinel
    const plan = makePlan([baseServicePlan("web", true)]);
    const recording = makeRecordingShell();
    const invocation: ToolingInvocation = {
      tool: "normalized-shell",
      commands: [["sh", "-c", 'printf %s "$@"', "lando-tooling", "hello"]],
    };

    // When the host engine runs with only commands (no hostSteps)
    const result = await Effect.runPromise(
      runHostToolingWith(recording.shell, invocation, plan, stubProvider),
    );

    // Then it decodes to structural Bun Shell source/argv and never launches sh -c
    expect(result.exitCode).toBe(0);
    expect(recording.calls()).toEqual([{ source: "printf %s", argv: ["hello"] }]);
  });

  test("does not strip the $@ sentinel without the lando-tooling marker", async () => {
    // Given a plain sh -c array whose source ends with the sentinel text but lacks the marker
    const plan = makePlan([baseServicePlan("web", true)]);
    const recording = makeRecordingShell();
    const invocation: ToolingInvocation = {
      tool: "no-marker",
      commands: [["sh", "-c", 'echo "$@"']],
    };

    // When decoded without the lando-tooling marker, the sentinel stays and is treated as authored $@
    const exit = await Effect.runPromiseExit(
      runHostToolingWith(recording.shell, invocation, plan, stubProvider),
    );

    // Then positional rejection fires (proves we did not strip to bare `echo`) and shell is never invoked
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value._tag).toBe("ToolingCompileError");
      }
    }
    expect(recording.calls()).toEqual([]);
  });

  test("decodes plain argv command arrays into argv host steps", async () => {
    // Given a commands-only argv array (not sh -c)
    const plan = makePlan([baseServicePlan("web", true)]);
    const recording = makeRecordingShell();
    const invocation: ToolingInvocation = {
      tool: "argv-only",
      commands: [["printf", "%s", "from-argv"]],
    };

    // When the host engine falls back to commands
    await Effect.runPromise(runHostToolingWith(recording.shell, invocation, plan, stubProvider));

    // Then the step is argv-shaped (empty shell source, full argv)
    expect(recording.calls()).toEqual([{ source: "", argv: ["printf", "%s", "from-argv"] }]);
  });

  test("prefers explicit hostSteps over commands when both are present", async () => {
    // Given both structural hostSteps and a conflicting commands array
    const plan = makePlan([baseServicePlan("web", true)]);
    const recording = makeRecordingShell();
    const invocation: ToolingInvocation = {
      tool: "host-steps-win",
      commands: [["sh", "-c", "printf from-commands"]],
      hostSteps: [{ kind: "shell", source: "printf from-host-steps", argv: [] }],
    };

    // When the host engine runs
    await Effect.runPromise(runHostToolingWith(recording.shell, invocation, plan, stubProvider));

    // Then only hostSteps execute
    expect(recording.calls()).toEqual([{ source: "printf from-host-steps", argv: [] }]);
  });

  test("rejects authored positional references decoded from normalized commands", async () => {
    // Given a normalized sh -c command whose authored source uses $1
    const plan = makePlan([baseServicePlan("web", true)]);
    const recording = makeRecordingShell();
    const invocation: ToolingInvocation = {
      tool: "positional-cmd",
      commands: [["sh", "-c", "echo $1", "lando-tooling", "arg"]],
    };

    // When the host engine tries to run it
    const exit = await Effect.runPromiseExit(
      runHostToolingWith(recording.shell, invocation, plan, stubProvider),
    );

    // Then compile fails closed and shell is never invoked
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value._tag).toBe("ToolingCompileError");
        if (failure.value._tag === "ToolingCompileError") {
          expect(failure.value.message).toContain("positional");
        }
      }
    }
    expect(recording.calls()).toEqual([]);
  });

  test("rejects authored positional references on explicit hostSteps", async () => {
    // Given an explicit shell host step with $@
    const plan = makePlan([baseServicePlan("web", true)]);
    const recording = makeRecordingShell();
    const invocation: ToolingInvocation = {
      tool: "positional-step",
      commands: [],
      hostSteps: [{ kind: "shell", source: 'printf %s "$@"', argv: ["x"] }],
    };

    // When run
    const exit = await Effect.runPromiseExit(
      runHostToolingWith(recording.shell, invocation, plan, stubProvider),
    );

    // Then compile rejects positional shell binding
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      if (failure._tag === "Some") {
        expect(failure.value._tag).toBe("ToolingCompileError");
      }
    }
    expect(recording.calls()).toEqual([]);
  });

  test("runs commands-only plain sh -c through the live host engine", async () => {
    // Given contract-style commands without hostSteps
    const plan = makePlan([baseServicePlan("web", true)]);
    const invocation: ToolingInvocation = {
      tool: "commands-only",
      commands: [
        ["sh", "-c", "printf one"],
        ["sh", "-c", "printf two"],
      ],
    };

    // When
    const result = await Effect.runPromise(runEngine(invocation, plan));

    // Then structural Bun Shell executes both steps
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("onetwo");
  });

  test("wraps shell launch failures as ToolingExecError carrying a ShellExecError cause", async () => {
    const plan = makePlan([baseServicePlan("web", true)]);
    const invocation: ToolingInvocation = {
      tool: "bad-syntax",
      commands: [["sh", "-c", "echo &&"]],
      hostSteps: [{ kind: "shell", source: "echo &&", argv: [] }],
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
