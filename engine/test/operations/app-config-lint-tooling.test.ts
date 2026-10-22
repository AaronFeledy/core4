import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getInternalToolingTasks } from "@lando/landofile/tooling-include-provenance";
import { makeLandoPaths } from "@lando/paths";
import { PluginManifest, PluginName } from "@lando/sdk/schema";
import { PathsService, PluginRegistry, type ServiceType, StateStore } from "@lando/sdk/services";
import { makeStateStore } from "@lando/state-store/service";
import { Effect, Layer, Schema } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import { lintLandofileSnapshot } from "../../src/services/landofile-live.ts";

const serviceType: ServiceType = {
  id: "reserved-tooling-test",
  name: "reserved-tooling-test",
  base: "l337",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "l337" as const,
      normalizedConfig: input.service,
      features: [],
      tooling: { run: { cmd: "echo service-run", service: ":host" } },
    }),
};

const registryLayer = Layer.effect(
  PluginRegistry,
  Effect.map(PluginRegistry, (registry) =>
    PluginRegistry.of({
      ...registry,
      list: Effect.succeed([
        Schema.decodeUnknownSync(PluginManifest)({
          name: PluginName.make("@lando/reserved-tooling-test"),
          version: "1.0.0",
          api: 4,
          contributes: { serviceTypes: [serviceType.id] },
        }),
      ]),
      loadServiceType: (id) =>
        id === serviceType.id ? Effect.succeed(serviceType) : registry.loadServiceType(id),
    }),
  ),
).pipe(Layer.provide(PluginRegistryLayer.layer));

test.each([
  {
    label: "authored task",
    tooling: "tooling:\n  run:\n    cmd: echo authored\n    service: ':host'\n",
    message:
      "Tooling task run can't use the name run, which belongs to the built-in apps:scratch:run command.",
    suggestion: "Rename tooling task run; run belongs to apps:scratch:run.",
    sourcePath: ["tooling", "run"],
  },
  {
    label: "service-type task",
    tooling: "",
    message:
      "Service type reserved-tooling-test task run can't use the name run, which belongs to the built-in apps:scratch:run command.",
    suggestion:
      "Set tooling.run.disabled: true in the Landofile to drop service type reserved-tooling-test's task, or redefine it under another name.",
    sourcePath: ["services", "web", "type"],
  },
])(
  "reports reserved $label with its introducing source",
  async ({ tooling, message, suggestion, sourcePath }) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-lint-tooling-"));
    try {
      await writeFile(
        join(root, ".lando.yml"),
        `name: tooling\nservices:\n  web:\n    type: ${serviceType.id}\n    home: false\n${tooling}`,
      );
      // When
      const result = await Effect.runPromise(
        appConfigLint({ cwd: root }).pipe(Effect.provide(registryLayer)),
      );
      // Then
      expect(result.valid).toBe(false);
      expect(result.violations).toEqual([
        expect.objectContaining({
          rule: "landofile.tooling",
          path: ["tooling", "run"],
          message,
          suggestion,
          source: expect.objectContaining({
            file: join(root, ".lando.yml"),
            layer: "canonical",
            path: sourcePath,
          }),
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("a disabled overlay drops a service type's reserved task", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-lint-tooling-disabled-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      `name: tooling\nservices:\n  web:\n    type: ${serviceType.id}\n    home: false\n`,
    );
    await writeFile(join(root, ".lando.local.yml"), "tooling:\n  run:\n    disabled: true\n");
    // When
    const result = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(registryLayer)));
    // Then
    expect(result).toMatchObject({ valid: true, violations: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([true, false])("reserved scratch include task with internal=%s", async (internal) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-lint-tooling-include-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      `name: tooling\ntoolingIncludes:\n  scratch:\n    file: ./tasks.yml\n    internal: ${internal}\n`,
    );
    await writeFile(
      join(root, "tasks.yml"),
      "tooling:\n  check:\n    cmd: echo check\n    service: ':host'\n",
    );
    const layers = Layer.mergeAll(
      PluginRegistryLayer.layer,
      Layer.succeed(PathsService, makeLandoPaths({ userCacheRoot: join(root, "cache") })),
      Layer.succeed(
        StateStore,
        makeStateStore({
          privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
        }),
      ),
    );
    // When
    const result = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(layers)));
    const snapshot = await Effect.runPromise(
      lintLandofileSnapshot({ cwd: root }).pipe(Effect.provide(layers)),
    );
    // Then
    expect(snapshot.resolved?.tooling).toHaveProperty(["scratch:check"]);
    expect(getInternalToolingTasks(snapshot.resolved ?? {}).includes("scratch:check")).toBe(internal);
    expect(result.valid).toBe(internal);
    expect(result.violations.map(({ rule, path }) => ({ rule, path }))).toEqual(
      internal ? [] : [{ rule: "landofile.tooling", path: ["tooling", "scratch:check"] }],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
