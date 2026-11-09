import { expect, test } from "bun:test";
import * as BunFileSystem from "@lando/engine/services/file-system";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { sha256Hex } from "@lando/sdk/digest";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, ProviderId, ServiceName } from "@lando/sdk/schema";
import { FileSystem, type ProviderRuntimeSnapshot, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import { missingAppRootsDoctor } from "../../src/cli/commands/doctor-missing-app-roots";

const root = AbsolutePath.make("/apps/gone");
const app = AppId.make("gone");
const providerId = ProviderId.make("test");
const snapshot = (appRoot = root, cache = false, runtimeObserved = true): ProviderRuntimeSnapshot => ({
  providerId,
  runtimeObserved,
  appliedPlans: [],
  services: [
    {
      app,
      appRoot,
      providerId,
      service: ServiceName.make("web"),
      status: "running",
      containerId: "observed-container",
      publications: { status: "unknown" },
    },
  ],
  volumes: [
    {
      ref: { app, store: "database" },
      identity: {
        coordinationKey: "key",
        nativeName: "native-data",
        generation: "1",
        ownerRoot: appRoot,
        origin: "created",
      },
    },
    ...(cache
      ? [
          {
            ref: { app, store: "cache" },
            labels: { "dev.lando.storage-kind": "cache" },
            identity: {
              coordinationKey: "cache",
              nativeName: "native-cache",
              generation: "1",
              ownerRoot: appRoot,
              origin: "created" as const,
            },
          },
        ]
      : []),
  ],
});
const registry = (snapshots: ReadonlyArray<ProviderRuntimeSnapshot>) =>
  RuntimeProviderRegistry.of({
    resolveAppliedPlan: () => Effect.succeed(undefined),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
    appliedPlansFor: () => Effect.succeed([]),
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
    select: () => Effect.succeed(TestRuntimeProvider),
    observeRuntime: Effect.succeed(snapshots),
  });
const fsLayer = Layer.effect(
  FileSystem,
  Effect.map(FileSystem, (fs) => ({ ...fs, exists: () => Effect.succeed(false) })),
).pipe(Layer.provide(BunFileSystem.layer));
const run = (
  snapshots: ReadonlyArray<ProviderRuntimeSnapshot>,
  redact: (text: string) => string = (text) => text,
) =>
  Effect.runPromise(
    missingAppRootsDoctor(redact).pipe(
      Effect.provide(Layer.merge(fsLayer, Layer.succeed(RuntimeProviderRegistry, registry(snapshots)))),
    ),
  );

test("does not scan without a registry", async () => {
  expect(
    await Effect.runPromise(missingAppRootsDoctor((text) => text).pipe(Effect.provide(fsLayer))),
  ).toEqual([]);
});

test("returns one redacted manual warning when app state cannot be read", async () => {
  // Given an inventory that cannot read provider state.
  const error = new ProviderUnavailableError({
    providerId,
    operation: "observeRuntime",
    message: "Unable to inspect secret-path applied plan state.",
    remediation:
      "Install or start the selected runtime provider and confirm it can perform `observeRuntime`.",
  });
  // When doctor collects missing-root checks.
  const checks = await Effect.runPromise(
    missingAppRootsDoctor((text) => text.replaceAll("secret-path", "[redacted]")).pipe(
      Effect.provide(
        Layer.merge(
          fsLayer,
          Layer.succeed(
            RuntimeProviderRegistry,
            RuntimeProviderRegistry.of({
              ...registry([]),
              observeRuntime: Effect.fail(error),
            }),
          ),
        ),
      ),
    ),
  );
  // Then the failed scan is a warning, not a doctor failure.
  expect(checks).toEqual([
    {
      name: "missing-app-root-scan",
      status: "warn",
      severity: "warn",
      recovery: "manual",
      context: { error: "Unable to inspect [redacted] applied plan state." },
      solutions: [
        {
          kind: "manual",
          description:
            "Lando could not read app state to look for app folders that no longer exist: Unable to inspect [redacted] applied plan state. Fix that problem, then rerun lando doctor.",
        },
      ],
    },
  ]);
});

test("does not observe the runtime without a filesystem", async () => {
  let observed = false;
  const checks = await Effect.runPromise(
    missingAppRootsDoctor((text) => text).pipe(
      Effect.provideService(
        RuntimeProviderRegistry,
        RuntimeProviderRegistry.of({
          ...registry([]),
          observeRuntime: Effect.sync(() => {
            observed = true;
            return [];
          }),
        }),
      ),
    ),
  );
  expect(checks).toEqual([]);
  expect(observed).toBe(false);
});

test("emits one manual warning per root and redacts every context value and solution", async () => {
  const checks = await run(
    [snapshot(), snapshot(AbsolutePath.make("/apps/second"))],
    (text) => `redacted(${text})`,
  );
  expect(checks).toHaveLength(2);
  expect(checks[0]).toMatchObject({
    name: "missing-app-root",
    status: "warn",
    severity: "warn",
    recovery: "manual",
    context: {
      appRoot: "redacted(/apps/gone)",
      apps: "redacted(gone)",
      providers: "redacted(test)",
      appliedState: "redacted(false)",
      runtimeObserved: "redacted(true)",
      containers: "redacted(gone/web)",
      dataVolumes: "redacted(native-data)",
    },
  });
  expect(checks[0]?.context).not.toHaveProperty("cacheVolumes");
  expect(checks[0]?.solutions[0]).toMatchObject({
    kind: "manual",
    command: "redacted(lando apps:gc --prune --volumes)",
  });
  expect(checks[0]?.solutions[0]?.description).toMatch(/^redacted\(/);
});

test.each([false, true])("purges caches only when cache volumes were observed: %s", async (cache) => {
  const checks = await run([snapshot(root, cache)]);
  expect(checks[0]?.solutions[0]?.command).toBe(
    `lando apps:gc --prune --volumes${cache ? " --purge-caches" : ""}`,
  );
});

test.each(["/apps/space name", "/apps/a;$(touch nope)", "/apps/it's gone"])(
  "uses the shared command without interpolating root %s into shell input",
  async (path) => {
    const checks = await run([snapshot(AbsolutePath.make(path))]);
    const command = checks[0]?.solutions[0]?.command;
    expect(command).toBe("lando apps:gc --prune --volumes");
    expect(command).not.toContain(`--root ${path} `);
  },
);

test.each([false, true])(
  "explains moved-folder and data choices, with incomplete-runtime guidance only when needed: %s",
  async (runtimeObserved) => {
    const checks = await run([snapshot(root, false, runtimeObserved)]);
    const description = checks[0]?.solutions[0]?.description ?? "";
    expect(description).toContain("move it back");
    expect(description).toContain("--volumes");
    const guidance =
      " Its runtime was not observed, so containers and volumes may be missing from this list.";
    expect(description.endsWith(guidance)).toBe(!runtimeObserved);
    expect(description).not.toContain("lando setup");
  },
);

test.each([false, true])(
  "missing-root journal remediation respects prepared targets: %s",
  async (prepared) => {
    const store = makeTestStateStore();
    const key = `${sha256Hex(JSON.stringify(JSON.stringify(["user", root])))}.json`;
    const bucket = await Effect.runPromise(
      store.service.open({
        root: "userData",
        namespace: "accelerated-starts",
        key,
        schema: Schema.Unknown,
        version: 2,
      }),
    );
    await Effect.runPromise(
      bucket.set({
        attemptId: "attempt-1",
        appId: app,
        appRoot: root,
        providerId,
        engineId: "mutagen",
        mountPlanDigest: "mounts",
        phase: "apply-intent",
        sessions: [{ name: "web/app-mount", specDigest: "session" }],
        targets: [
          { service: "web", mountKey: "app-mount", volumeName: "app-sync", helperSpecDigest: "helper" },
        ],
      }),
    );
    const corruptKey = `${"b".repeat(64)}.json`;
    const corrupt = await Effect.runPromise(
      store.service.open({
        root: "userData",
        namespace: "accelerated-starts",
        key: corruptKey,
        schema: Schema.Unknown,
        version: 2,
      }),
    );
    await Effect.runPromise(corrupt.set({ broken: true }));
    const checks = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        return yield* missingAppRootsDoctor((value) => value).pipe(
          Effect.provideService(FileSystem, {
            ...fs,
            exists: () => Effect.succeed(false),
            readDir: () => Effect.succeed([corruptKey, key]),
          }),
          Effect.provideService(RuntimeProviderRegistry, {
            ...registry([snapshot(), snapshot(AbsolutePath.make("/apps/second"), true)]),
            select: () =>
              Effect.succeed({
                ...TestRuntimeProvider,
                capabilities: {
                  ...TestRuntimeProvider.capabilities,
                  ...(prepared ? { fileSyncTargets: "prepared-volume" as const } : {}),
                },
              }),
          }),
          Effect.provide(store.layer),
        );
      }).pipe(Effect.provide(BunFileSystem.layer)),
    );
    expect(checks).toHaveLength(2);
    expect(checks[0]?.context).toMatchObject({
      attempts: "attempt-1",
      phases: "apply-intent",
      engines: "mutagen",
      sessions: "web/app-mount",
      targets: "app-sync",
    });
    expect(checks.map((check) => check.solutions[0]?.command)).toEqual([
      `lando apps:gc --prune${prepared ? "" : " --volumes"} --purge-caches`,
      `lando apps:gc --prune${prepared ? "" : " --volumes"} --purge-caches`,
    ]);
    if (prepared) expect(checks[0]?.solutions[0]?.description).toContain("cannot remove");
    expect(await Effect.runPromise(corrupt.get)).toEqual({ broken: true });
  },
);
