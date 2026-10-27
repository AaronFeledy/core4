import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileValidationError } from "@lando/sdk/errors";
import {
  type AppPlan,
  LandofileShape,
  PortablePath,
  type ProviderCapabilities,
  ServiceName,
} from "@lando/sdk/schema";
import { AppPlanner, FileSystem, PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import { compileAuthoredMounts } from "../../src/planner/authored-mounts.ts";
import { loadComposeConfigFiles } from "../../src/planner/config-files.ts";
import * as Plugins from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import * as Planner from "../../src/services/planner.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";

const withApp = async <A>(
  service: Record<string, unknown>,
  run: (app: {
    readonly root: string;
    readonly plan: (capabilities?: ProviderCapabilities) => Promise<AppPlan>;
    readonly lint: (
      capabilities?: ProviderCapabilities,
    ) => Promise<Effect.Success<ReturnType<typeof appConfigLint>>>;
  }) => Promise<A>,
): Promise<A> => {
  const root = await mkdtemp(join(tmpdir(), "lando-config-mounts-"));
  try {
    const input = {
      name: "configmounts",
      runtime: 4,
      configs: { first: { file: "./config.txt" }, second: { file: "./config.txt" } },
      services: { web: { type: "compose", image: "alpine", appMount: false, home: false, ...service } },
    };
    const document = Schema.decodeUnknownSync(LandofileShape)(input);
    await writeFile(join(root, ".lando.yml"), Bun.YAML.stringify(input, null, 2));
    await writeFile(join(root, "config.txt"), "config data");
    return await run({
      root,
      plan: (capabilities = TestRuntimeProvider.capabilities) =>
        Effect.runPromise(
          Effect.flatMap(AppPlanner, (planner) =>
            planner.plan(literalTestLandofile(document, root), capabilities),
          ).pipe(
            Effect.provide(
              Planner.layer.pipe(Layer.provide(Layer.mergeAll(Plugins.layer, BunFileSystem.layer))),
            ),
          ),
        ),
      lint: (capabilities = TestRuntimeProvider.capabilities) =>
        Effect.runPromise(
          Effect.flatMap(PluginRegistry, (registry) =>
            appConfigLint({ cwd: root }).pipe(
              Effect.provideService(PluginRegistry, {
                ...registry,
                declaredProviderCapabilities: () => capabilities,
              }),
            ),
          ).pipe(Effect.provide(Plugins.layer)),
        ),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test.each([undefined, "0440", 0o640])(
  "configs compile default targets and mode %s into strict authored binds",
  async (mode) => {
    await withApp(
      { configs: [{ source: "first", ...(mode === undefined ? {} : { mode }) }] },
      async ({ root, plan }) => {
        const app = await plan();
        expect(app.services[ServiceName.make("web")]?.mounts).toEqual([
          {
            type: "bind",
            source: join(root, "config.txt"),
            target: PortablePath.make("/first"),
            readOnly: true,
            realization: "passthrough",
            createHostPath: false,
            origin: "authored",
            relativeTo: "app",
            ...(mode === undefined ? {} : { fileMode: typeof mode === "string" ? 0o440 : mode }),
          },
        ]);
      },
    );
  },
);

test.each([
  {
    volumes: ["./a:/same/", "./b:/same"],
    configs: [],
    paths: [
      ["volumes", 0],
      ["volumes", 1],
    ],
  },
  {
    volumes: ["./a:/same/"],
    configs: [{ source: "first", target: "/same" }],
    paths: [
      ["volumes", 0],
      ["configs", 0],
    ],
  },
  {
    volumes: [],
    configs: [
      { source: "first", target: "/same/" },
      { source: "second", target: "/same" },
    ],
    paths: [
      ["configs", 0],
      ["configs", 1],
    ],
  },
])("lint and planning reject duplicate Compose destinations $paths", async ({ volumes, configs, paths }) => {
  await withApp({ volumes, configs }, async ({ plan, lint }) => {
    const expected = paths.map((path) => ["services", "web", ...path]);
    await expect(plan()).rejects.toMatchObject({
      _tag: "LandofileValidationError",
      issues: expected.map((path) => expect.objectContaining({ path })),
    });
    const result = await lint();
    expect(result.valid).toBe(false);
    expect(result.violations).toMatchObject(expected.map((path) => ({ path })));
  });
});

test.each(["mounts", "storage", "tmpfs"])("Lando %s wins over a config grant", async (key) => {
  const entry = key === "mounts" ? [{ type: "tmpfs", target: "/same" }] : ["/same"];
  await withApp({ [key]: entry, configs: [{ source: "first", target: "/same" }] }, async ({ plan }) => {
    const mounts = (await plan()).services[ServiceName.make("web")]?.mounts;
    expect(mounts).toHaveLength(1);
    expect(mounts?.[0]).toMatchObject({
      target: "/same",
      origin: "authored",
      type: key === "storage" ? "volume" : "tmpfs",
    });
  });
});

test.each([
  { name: "configs", service: { configs: ["first"] }, bindError: true },
  { name: "tmpfs", service: { tmpfs: ["/scratch"] }, bindError: false },
])("lint derives mount capabilities from a $name-only service", async ({ service, bindError }) => {
  await withApp(service, async ({ lint }) => {
    const result = await lint({
      ...TestRuntimeProvider.capabilities,
      bindMounts: false,
      persistentStorage: false,
    });
    expect(result.valid).toBe(!bindError);
    expect(result.violations.map(({ path }) => path)).toEqual(
      bindError ? [["services", "web", "appMount"]] : [],
    );
  });
});

test("config grants retain service capability gating before provider action", async () => {
  await withApp({ configs: ["first"] }, async ({ plan, lint }) => {
    const capabilities = { ...TestRuntimeProvider.capabilities, composeServiceFields: { supported: [] } };
    await expect(plan(capabilities)).rejects.toMatchObject({ _tag: "CapabilityError", key: "configs" });
    const result = await lint(capabilities);
    expect(result.valid).toBe(false);
    expect(result.violations.some(({ path }) => path.join(".") === "services.web.configs")).toBe(true);
  });
});

test.each(["garbage", "0888", -1, 0o10000, 1.5])(
  "invalid config mode %s fails lint and planning",
  async (mode) => {
    await withApp({ configs: [{ source: "first", mode }] }, async ({ plan, lint }) => {
      await expect(plan()).rejects.toMatchObject({ _tag: "LandofileValidationError" });
      expect((await lint()).valid).toBe(false);
    });
  },
);

test.each([
  ["./config.txt", "app"],
  ["../config.txt", "app"],
  ["/host/config.txt", undefined],
  ["~/config.txt", undefined],
  ["C:\\host\\config.txt", undefined],
  ["\\\\host\\share\\config.txt", undefined],
] as const)("config source %s records lexical relativity", (file, relativeTo) => {
  const config = Schema.decodeUnknownSync(LandofileShape)({ services: { web: { configs: ["first"] } } })
    .services?.[ServiceName.make("web")];
  if (config === undefined) throw new Error("missing service");
  const mounts = compileAuthoredMounts(
    { appRoot: "/canonical/app", appSlug: "app", serviceName: "web", configs: { first: { file } } },
    config,
    undefined,
  );
  if (mounts instanceof LandofileValidationError) throw mounts;
  expect(mounts[0]?.type === "bind" ? mounts[0].relativeTo : undefined).toBe(relativeTo);
});

test("shared project config definitions are read once per plan rather than per service grant", async () => {
  const document = Schema.decodeUnknownSync(LandofileShape)({
    configs: { first: { file: "./config.txt" } },
    services: { one: { configs: ["first"] }, two: { configs: ["first"] } },
  });
  const reads: string[] = [];
  const result = await Effect.runPromise(
    Effect.flatMap(FileSystem, (fileSystem) =>
      loadComposeConfigFiles({
        appRoot: "/canonical/app",
        landofile: document,
        capabilities: TestRuntimeProvider.capabilities,
        fileSystem: {
          ...fileSystem,
          readText: (path) =>
            Effect.sync(() => {
              reads.push(path);
              return "config data";
            }),
        },
      }),
    ).pipe(Effect.provide(BunFileSystem.layer)),
  );
  expect(reads).toEqual(["/canonical/app/config.txt"]);
  expect(result).toHaveLength(1);
});
