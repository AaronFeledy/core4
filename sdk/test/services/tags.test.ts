import { describe, expect, test } from "bun:test";

import { Context, DateTime, Effect, Stream } from "effect";

import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";

import {
  AppPlanner,
  BuildOrchestrator,
  CacheService,
  ConfigService,
  EventService,
  FileSystem,
  LandofileService,
  Logger,
  PluginRegistry,
  ProcessRunner,
  RuntimeProvider,
  RuntimeProviderRegistry,
  ShellRunner,
} from "@lando/sdk/services";

const EXPECTED_TAGS = [
  { tag: Logger, key: "@lando/core/Logger", methods: ["debug", "info", "warn", "error"] },
  {
    tag: EventService,
    key: "@lando/core/EventService",
    methods: ["publish", "subscribe", "subscribeQueue", "waitFor"],
  },
  {
    tag: RuntimeProvider,
    key: "@lando/core/RuntimeProvider",
    methods: [
      "isAvailable",
      "setup",
      "getStatus",
      "getVersions",
      "buildArtifact",
      "pullArtifact",
      "removeArtifact",
      "apply",
      "start",
      "stop",
      "restart",
      "destroy",
      "exec",
      "execStream",
      "run",
      "logs",
      "inspect",
      "list",
    ],
  },
  {
    tag: RuntimeProviderRegistry,
    key: "@lando/core/RuntimeProviderRegistry",
    methods: ["list", "capabilities", "select"],
  },
  { tag: ConfigService, key: "@lando/core/ConfigService", methods: ["load", "get"] },
  { tag: LandofileService, key: "@lando/core/LandofileService", methods: ["discover"] },
  { tag: AppPlanner, key: "@lando/core/AppPlanner", methods: ["plan"] },
  { tag: BuildOrchestrator, key: "@lando/core/BuildOrchestrator", methods: ["build"] },
  { tag: PluginRegistry, key: "@lando/core/PluginRegistry", methods: ["list", "load", "loadServiceType"] },
  { tag: CacheService, key: "@lando/core/CacheService", methods: ["read", "write", "invalidate"] },
  {
    tag: FileSystem,
    key: "@lando/core/FileSystem",
    methods: [
      "read",
      "readText",
      "write",
      "writeAtomic",
      "exists",
      "stat",
      "lstat",
      "mkdir",
      "remove",
      "readDir",
      "readFile",
      "writeFile",
    ],
  },
  { tag: ProcessRunner, key: "@lando/core/ProcessRunner", methods: ["run", "stream"] },
  { tag: ShellRunner, key: "@lando/core/ShellRunner", methods: ["exec", "run", "runScript"] },
] as const;

type FailureOf<T> = T extends Effect.Effect<unknown, infer E, unknown>
  ? E
  : T extends Stream.Stream<unknown, infer E, unknown>
    ? E
    : never;

type TaggedFailure<E> = [E] extends [never] ? never : E extends { readonly _tag: string } ? true : never;

const assertTaggedFailure = <T extends true>(value: T): T => value;

describe("Effect service tags", () => {
  test("exports the service tags as Context.Tag instances", () => {
    for (const { tag, key } of EXPECTED_TAGS) {
      expect(Context.isTag(tag)).toBe(true);
      expect(tag.key).toBe(key);
    }
  });

  test("freezes each documented service method name", () => {
    const expectedMethods: string[][] = [
      ["debug", "info", "warn", "error"],
      ["publish", "subscribe", "subscribeQueue", "waitFor"],
      [
        "isAvailable",
        "setup",
        "getStatus",
        "getVersions",
        "buildArtifact",
        "pullArtifact",
        "removeArtifact",
        "apply",
        "start",
        "stop",
        "restart",
        "destroy",
        "exec",
        "execStream",
        "run",
        "logs",
        "inspect",
        "list",
      ],
      ["list", "capabilities", "select"],
      ["load", "get"],
      ["discover"],
      ["plan"],
      ["build"],
      ["list", "load", "loadServiceType"],
      ["read", "write", "invalidate"],
      [
        "read",
        "readText",
        "write",
        "writeAtomic",
        "exists",
        "stat",
        "lstat",
        "mkdir",
        "remove",
        "readDir",
        "readFile",
        "writeFile",
      ],
      ["run", "stream"],
      ["exec", "run", "runScript"],
    ];

    const actualMethods: string[][] = EXPECTED_TAGS.map(({ methods }) => [...methods]);
    expect(actualMethods).toEqual(expectedMethods);
  });

  test("service methods return Effect or Stream values", () => {
    const logger: Context.Tag.Service<typeof Logger> = {
      debug: (_message: string) => Effect.void,
      info: (_message: string) => Effect.void,
      warn: (_message: string) => Effect.void,
      error: (_message: string) => Effect.void,
    };

    const eventService: Context.Tag.Service<typeof EventService> = {
      publish: (_event: { readonly _tag: string }) => Effect.void,
      subscribe: (_name: string) => Stream.empty,
      subscribeQueue: Effect.never as Context.Tag.Service<typeof EventService>["subscribeQueue"],
      waitFor: (_name: string) => Effect.succeed({ _tag: "test-event" }),
    };

    const cacheService: Context.Tag.Service<typeof CacheService> = {
      read: (_key: string) => Effect.succeed(null),
      write: (_key: string, _value: unknown) => Effect.void,
      invalidate: (_key: string) => Effect.void,
    };

    const processRunner: Context.Tag.Service<typeof ProcessRunner> = {
      run: (_options) => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      stream: (_options) => Stream.empty,
    };

    const shellRunner: Context.Tag.Service<typeof ShellRunner> = {
      exec: (_command: string) => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      run: (_command: string) => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      runScript: (_path: string) => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    };

    const fileSystem: Context.Tag.Service<typeof FileSystem> = {
      read: (_path: string) => Stream.empty,
      readText: (_path: string) => Effect.succeed(""),
      write: (_path: string, _content: string | Uint8Array) => Effect.void,
      writeAtomic: (_path: string, _content: string | Uint8Array) => Effect.void,
      exists: (_path: string) => Effect.succeed(false),
      stat: (_path: string) => Effect.succeed({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
      lstat: (_path: string) => Effect.succeed({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
      mkdir: (_path: string) => Effect.void,
      remove: (_path: string) => Effect.void,
      readDir: (_path: string) => Effect.succeed([]),
      readFile: (_path: string) => Effect.succeed(""),
      writeFile: (_path: string, _content: string) => Effect.void,
    };

    const buildOrchestrator: Context.Tag.Service<typeof BuildOrchestrator> = {
      build: (_plan) => Effect.void,
    };

    const appPlan: AppPlan = {
      id: AppId.make("myapp"),
      name: "My App",
      slug: "myapp",
      root: AbsolutePath.make("/srv/apps/myapp"),
      provider: ProviderId.make("test"),
      services: {},
      routes: [],
      networks: [],
      stores: [],
      metadata: {
        resolvedAt: DateTime.unsafeMake("2026-05-14T00:00:00Z"),
        source: "tags.test",
        runtime: 4,
      },
      extensions: {},
    };

    expect(Effect.isEffect(logger.info("ready"))).toBe(true);
    expect(Effect.isEffect(eventService.publish({ _tag: "test-event" }))).toBe(true);
    expect(Stream.StreamTypeId in Object(eventService.subscribe("test-event"))).toBe(true);
    expect(Effect.isEffect(cacheService.read("key"))).toBe(true);
    expect(Effect.isEffect(fileSystem.readText("/tmp/file"))).toBe(true);
    expect(Stream.StreamTypeId in Object(fileSystem.read("/tmp/file"))).toBe(true);
    expect(Effect.isEffect(processRunner.run({ cmd: "true", args: [] }))).toBe(true);
    expect(Stream.StreamTypeId in Object(processRunner.stream({ cmd: "true", args: [] }))).toBe(true);
    expect(Effect.isEffect(shellRunner.exec("echo ok"))).toBe(true);
    expect(Effect.isEffect(buildOrchestrator.build(appPlan))).toBe(true);
  });

  test("method failure channels use SDK tagged errors", () => {
    const assertions = [
      assertTaggedFailure<TaggedFailure<FailureOf<ReturnType<Context.Tag.Service<typeof Logger>["info"]>>>>(
        true,
      ),
      assertTaggedFailure<
        TaggedFailure<FailureOf<ReturnType<Context.Tag.Service<typeof EventService>["publish"]>>>
      >(true),
      assertTaggedFailure<
        TaggedFailure<FailureOf<ReturnType<Context.Tag.Service<typeof RuntimeProvider>["apply"]>>>
      >(true),
      assertTaggedFailure<
        TaggedFailure<FailureOf<ReturnType<Context.Tag.Service<typeof RuntimeProviderRegistry>["select"]>>>
      >(true),
      assertTaggedFailure<TaggedFailure<FailureOf<Context.Tag.Service<typeof ConfigService>["load"]>>>(true),
      assertTaggedFailure<TaggedFailure<FailureOf<Context.Tag.Service<typeof LandofileService>["discover"]>>>(
        true,
      ),
      assertTaggedFailure<
        TaggedFailure<FailureOf<ReturnType<Context.Tag.Service<typeof AppPlanner>["plan"]>>>
      >(true),
      assertTaggedFailure<
        TaggedFailure<FailureOf<ReturnType<Context.Tag.Service<typeof BuildOrchestrator>["build"]>>>
      >(true),
      assertTaggedFailure<TaggedFailure<FailureOf<Context.Tag.Service<typeof PluginRegistry>["list"]>>>(true),
      assertTaggedFailure<
        TaggedFailure<FailureOf<ReturnType<Context.Tag.Service<typeof CacheService>["read"]>>>
      >(true),
      assertTaggedFailure<
        TaggedFailure<FailureOf<ReturnType<Context.Tag.Service<typeof FileSystem>["exists"]>>>
      >(true),
      assertTaggedFailure<
        TaggedFailure<FailureOf<ReturnType<Context.Tag.Service<typeof ProcessRunner>["run"]>>>
      >(true),
      assertTaggedFailure<
        TaggedFailure<FailureOf<ReturnType<Context.Tag.Service<typeof ShellRunner>["run"]>>>
      >(true),
    ];

    expect(assertions.every(Boolean)).toBe(true);
  });
});
