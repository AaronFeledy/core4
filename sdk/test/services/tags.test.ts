import { describe, expect, test } from "bun:test";

import { Context, Effect, Stream } from "effect";

import {
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
  { tag: EventService, key: "@lando/core/EventService", methods: ["publish", "subscribe", "waitFor"] },
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
  { tag: RuntimeProviderRegistry, key: "@lando/core/RuntimeProviderRegistry", methods: ["list", "select"] },
  { tag: ConfigService, key: "@lando/core/ConfigService", methods: ["load", "get"] },
  { tag: LandofileService, key: "@lando/core/LandofileService", methods: ["discover"] },
  { tag: PluginRegistry, key: "@lando/core/PluginRegistry", methods: ["list", "load"] },
  { tag: CacheService, key: "@lando/core/CacheService", methods: ["read", "write", "invalidate"] },
  {
    tag: FileSystem,
    key: "@lando/core/FileSystem",
    methods: ["readFile", "writeFile", "writeAtomic", "exists"],
  },
  { tag: ProcessRunner, key: "@lando/core/ProcessRunner", methods: ["spawn"] },
  { tag: ShellRunner, key: "@lando/core/ShellRunner", methods: ["run", "runScript"] },
] as const;

type FailureOf<T> = T extends Effect.Effect<unknown, infer E, unknown>
  ? E
  : T extends Stream.Stream<unknown, infer E, unknown>
    ? E
    : never;

type TaggedFailure<E> = [E] extends [never] ? never : E extends { readonly _tag: string } ? true : never;

const assertTaggedFailure = <T extends true>(value: T): T => value;

describe("Effect service tags", () => {
  test("exports the Phase 1 service tags as Context.Tag instances", () => {
    for (const { tag, key } of EXPECTED_TAGS) {
      expect(Context.isTag(tag)).toBe(true);
      expect(tag.key).toBe(key);
    }
  });

  test("freezes each documented service method name", () => {
    expect(EXPECTED_TAGS.map(({ methods }) => methods)).toEqual([
      ["debug", "info", "warn", "error"],
      ["publish", "subscribe", "waitFor"],
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
      ["list", "select"],
      ["load", "get"],
      ["discover"],
      ["list", "load"],
      ["read", "write", "invalidate"],
      ["readFile", "writeFile", "writeAtomic", "exists"],
      ["spawn"],
      ["run", "runScript"],
    ]);
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
      waitFor: (_name: string) => Effect.succeed({ _tag: "test-event" }),
    };

    const cacheService: Context.Tag.Service<typeof CacheService> = {
      read: (_key: string) => Effect.succeed(null),
      write: (_key: string, _value: unknown) => Effect.void,
      invalidate: (_key: string) => Effect.void,
    };

    const processRunner: Context.Tag.Service<typeof ProcessRunner> = {
      spawn: (_options: { readonly args: ReadonlyArray<string> }) =>
        Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    };

    const shellRunner: Context.Tag.Service<typeof ShellRunner> = {
      run: (_command: string) => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      runScript: (_path: string) => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    };

    expect(Effect.isEffect(logger.info("ready"))).toBe(true);
    expect(Effect.isEffect(eventService.publish({ _tag: "test-event" }))).toBe(true);
    expect(Stream.StreamTypeId in Object(eventService.subscribe("test-event"))).toBe(true);
    expect(Effect.isEffect(cacheService.read("key"))).toBe(true);
    expect(Effect.isEffect(processRunner.spawn({ args: ["true"] }))).toBe(true);
    expect(Effect.isEffect(shellRunner.run("echo ok"))).toBe(true);
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
      assertTaggedFailure<TaggedFailure<FailureOf<Context.Tag.Service<typeof PluginRegistry>["list"]>>>(true),
      assertTaggedFailure<
        TaggedFailure<FailureOf<ReturnType<Context.Tag.Service<typeof CacheService>["read"]>>>
      >(true),
      assertTaggedFailure<
        TaggedFailure<FailureOf<ReturnType<Context.Tag.Service<typeof FileSystem>["exists"]>>>
      >(true),
      assertTaggedFailure<
        TaggedFailure<FailureOf<ReturnType<Context.Tag.Service<typeof ProcessRunner>["spawn"]>>>
      >(true),
      assertTaggedFailure<
        TaggedFailure<FailureOf<ReturnType<Context.Tag.Service<typeof ShellRunner>["run"]>>>
      >(true),
    ];

    expect(assertions.every(Boolean)).toBe(true);
  });
});
