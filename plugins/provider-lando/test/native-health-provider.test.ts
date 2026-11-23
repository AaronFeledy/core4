import { expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { ProcessRunner, type RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect, Stream } from "effect";
import { makeManagedNativeHealth, withNativeHealthReconcile } from "../src/native-health-provider.ts";

const lifecycle = [
  "apply",
  "start",
  "restart",
  "stop",
  "destroy",
  "resume",
  "suspend",
  "removeObservedService",
  "quiesceForFileSync",
] as const;

const failure = new ProviderUnavailableError({
  providerId: "lando",
  operation: "test",
  message: "Failed.",
  remediation: "Retry.",
});

const provider = (outcome: "succeed" | "fail"): RuntimeProviderShape => {
  const result = outcome === "succeed" ? Effect.void : Effect.fail(failure);
  return {
    ...TestRuntimeProvider,
    ...Object.fromEntries(lifecycle.map((name) => [name, () => result])),
    exec: () => Effect.die("unused"),
  };
};

const target = { app: AppId.make("app"), service: ServiceName.make("web") };
const identity = { containerId: "c", imageIdentity: "i" };
const observed = {
  ...target,
  providerId: ProviderId.make("lando"),
  status: "running",
  publications: { status: "unknown" },
} as const;

const plan: AppPlan = {
  id: target.app,
  name: "App",
  slug: "app",
  root: AbsolutePath.make("/tmp/app"),
  provider: ProviderId.make("lando"),
  services: {},
  routes: [],
  stores: [],
  fileSync: [],
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-11-23T00:00:00Z"), source: "test", runtime: 4 },
  extensions: {},
};

const invoke = (
  p: RuntimeProviderShape,
  name: (typeof lifecycle)[number],
): Effect.Effect<unknown, unknown> => {
  switch (name) {
    case "apply":
      return Effect.scoped(p.apply(plan, { reconcile: false }));
    case "start":
    case "restart":
    case "stop":
      return p[name](target);
    case "destroy":
      return p.destroy({ app: target.app }, { volumes: false });
    case "resume":
    case "suspend":
      return p[name]?.(target, identity) ?? Effect.die(`${name} is missing`);
    case "removeObservedService":
      return p.removeObservedService(observed);
    case "quiesceForFileSync":
      return p.quiesceForFileSync?.({ app: target.app }) ?? Effect.die(`${name} is missing`);
    default:
      return name satisfies never;
  }
};

const call = (wrapped: RuntimeProviderShape, name: (typeof lifecycle)[number]) =>
  Effect.runPromise(Effect.exit(invoke(wrapped, name)));

test.each(lifecycle)(
  "reconciles health timers after a successful %s, never after a failed one",
  async (name) => {
    let reconciled = 0;
    const reconcile = Effect.sync(() => reconciled++);
    await call(withNativeHealthReconcile(provider("succeed"), reconcile), name);
    expect(reconciled).toBe(1);
    await call(withNativeHealthReconcile(provider("fail"), reconcile), name);
    expect(reconciled).toBe(1);
  },
);

test("leaves run, exec, inspect, logs and list alone", () => {
  const base = provider("succeed");
  const wrapped = withNativeHealthReconcile(base, Effect.die("must not reconcile"));
  for (const name of ["run", "runStream", "exec", "inspect", "logs", "list"] as const) {
    expect(Reflect.get(wrapped, name)).toBe(Reflect.get(base, name));
  }
});

test("adds no optional lifecycle method the provider lacks", () => {
  const { resume: _resume, suspend: _suspend, quiesceForFileSync: _quiesce, ...base } = provider("succeed");
  const wrapped = withNativeHealthReconcile(base, Effect.void);
  expect(["resume", "suspend", "quiesceForFileSync"].filter((name) => name in wrapped)).toEqual([]);
});

test("redacts the warning it publishes when scheduling fails", async () => {
  // Given a runtime API whose failure message carries a secret
  const published: unknown[] = [];
  const health = makeManagedNativeHealth({
    tools: {
      systemdRun: "/usr/bin/systemd-run",
      systemctl: "/usr/bin/systemctl",
      userRuntimeDir: "/run/user/1",
    },
    processRunner: ProcessRunner.of({
      run: () => Effect.die("no timer is created"),
      stream: () => Stream.die("unused"),
      streamWithExit: () => Stream.die("unused"),
    }),
    api: {
      request: () =>
        Effect.fail(new ProviderUnavailableError({ ...failure, message: "the runtime said hunter2-secret" })),
    },
    host: {
      uid: () => 1,
      isExecutable: () => false,
      exists: () => false,
      readText: () => undefined,
      ownerUid: () => 1,
    },
    pidPath: "/tmp/none/podman.pid",
    prefix: "lando-0123456789abcdef-hc-",
    runtimeBinDir: "/tmp/none/bin",
    socketPath: "/tmp/none/podman.sock",
    runtimeConfigDir: "/tmp/none/config",
    dataRoot: "/tmp/none",
    stateStore: undefined,
    eventService: { publish: (event) => Effect.sync(() => published.push(event)) },
    redactor: createStandaloneRedactor("secrets", { sourceEnv: {}, redactionTokens: ["hunter2-secret"] }),
  });
  // When a started container is enrolled
  await Effect.runPromise(health.enroll("c"));
  // Then the warning names the failure without the secret
  expect(JSON.stringify(published)).not.toContain("hunter2-secret");
  expect(published).toEqual([expect.objectContaining({ _tag: "message.warn" })]);
});
