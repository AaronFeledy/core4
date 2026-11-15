import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { PluginManifest, PluginName } from "@lando/sdk/schema";
import { PathsService, PluginRegistry, type ServiceType, StateStore } from "@lando/sdk/services";
import { makeStateStore } from "@lando/state-store/service";
import { Effect, Layer, Schema } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";

const serviceType: ServiceType = {
  id: "declaration-test",
  name: "declaration-test",
  base: "l337",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "l337" as const,
      normalizedConfig: input.service,
      features: [],
      tooling: { contributed: { cmd: "echo tool", wrapper: true, flags: { verbose: { boolean: true } } } },
    }),
};
const registryLayer = Layer.effect(
  PluginRegistry,
  Effect.map(PluginRegistry, (registry) =>
    PluginRegistry.of({
      ...registry,
      list: Effect.succeed([
        Schema.decodeUnknownSync(PluginManifest)({
          name: PluginName.make("@lando/declaration-test"),
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

const contributedService =
  "services:\n  web:\n    type: declaration-test\n    image: alpine:3.22\n    home: false\n";

test("lint aggregates alias and wrapper declaration failures (#2325)", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-declarations-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      `name: declarations
tooling:
  aliasclash:
    cmd: echo alias
    flags:
      one:
        alias: x
      two:
        alias: x
  wrapdecl:
    cmd: echo wrapper
    wrapper: true
    flags:
      verbose:
        boolean: true
  ok:
    cmd: echo ok
`,
    );
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    expect(result.valid).toBe(false);
    expect(
      result.violations.filter((issue) => issue.rule === "landofile.tooling").map((issue) => issue.path),
    ).toEqual([
      ["tooling", "aliasclash", "flags", "two", "alias"],
      ["tooling", "wrapdecl", "wrapper"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  {
    label: "dynamic and host-shell fields in an enabled internal include",
    canonical: "toolingIncludes:\n  helpers:\n    file: ./tasks.yml\n    internal: true\n",
    fragment:
      "tooling:\n  dynamic:\n    service: ':host'\n    cmd: echo {{ flags.naem }}\n    flags:\n      name:\n        default: world\n  shell:\n    service: ':host'\n    cmd: echo $?\n",
    local:
      "tooling:\n  helpers:dynamic:\n    description: local metadata\n  helpers:shell:\n    description: local metadata\n",
    paths: [
      ["tooling", "helpers:dynamic", "cmd"],
      ["tooling", "helpers:shell", "cmd"],
    ],
    sources: [
      { file: "tasks.yml", layer: "canonical", path: ["tooling", "dynamic", "cmd"] },
      { file: "tasks.yml", layer: "canonical", path: ["tooling", "shell", "cmd"] },
    ],
  },
  {
    label: "dynamic and host-shell local overrides",
    canonical:
      "tooling:\n  dynamic:\n    service: ':host'\n    cmd: echo root\n    flags:\n      name:\n        default: world\n  shell:\n    service: ':host'\n    cmd: echo root\n",
    fragment: "",
    local: "tooling:\n  dynamic:\n    cmd: echo {{ flags.naem }}\n  shell:\n    cmd: echo $?\n",
    paths: [
      ["tooling", "dynamic", "cmd"],
      ["tooling", "shell", "cmd"],
    ],
    sources: [
      { file: ".lando.local.yml", layer: "local", path: ["tooling", "dynamic", "cmd"] },
      { file: ".lando.local.yml", layer: "local", path: ["tooling", "shell", "cmd"] },
    ],
  },
  {
    label: "disabled task skips dynamic, declaration, host-shell and reserved-name checks",
    canonical:
      "tooling:\n  start:\n    disabled: true\n    service: ':host'\n    wrapper: true\n    flags:\n      name:\n        default: world\n    cmd: echo {{ flags.naem }}\n    vars:\n      X:\n        sh: echo $?\n",
    local: "",
    fragment: "",
    paths: [],
    sources: [],
  },
  {
    label: "enabled internal namespace",
    canonical: "toolingIncludes:\n  helpers:\n    file: ./tasks.yml\n    internal: true\n",
    fragment:
      "tooling:\n  bad:\n    cmd: echo tool\n    wrapper: true\n    flags:\n      verbose:\n        boolean: true\n",
    local: "",
    paths: [["tooling", "helpers:bad", "wrapper"]],
    sources: [{ file: "tasks.yml", layer: "canonical", path: ["tooling", "bad", "wrapper"] }],
  },
  {
    label: "winning local flag",
    canonical:
      "tooling:\n  bad:\n    cmd: echo tool\n    flags:\n      one:\n        alias: x\n      two:\n        alias: y\n",
    local: "tooling:\n  bad:\n    flags:\n      two:\n        alias: x\n",
    fragment: "",
    paths: [["tooling", "bad", "flags", "two", "alias"]],
    sources: [
      { file: ".lando.local.yml", layer: "local", path: ["tooling", "bad", "flags", "two", "alias"] },
    ],
  },
  {
    label: "inherited defaults env",
    canonical: "toolingDefaults:\n  env:\n    LANDO_X: hidden\ntooling:\n  bad:\n    cmd: echo tool\n",
    local: "",
    fragment: "",
    paths: [["tooling", "bad", "env", "LANDO_X"]],
    sources: [{ file: ".lando.yml", layer: "canonical", path: ["toolingDefaults", "env", "LANDO_X"] }],
  },
  {
    label: "task override of defaults env",
    canonical: "toolingDefaults:\n  env:\n    LANDO_X: hidden\ntooling:\n  bad:\n    cmd: echo tool\n",
    local: "tooling:\n  bad:\n    env:\n      LANDO_X: hidden-local\n",
    fragment: "",
    paths: [["tooling", "bad", "env", "LANDO_X"]],
    sources: [{ file: ".lando.local.yml", layer: "local", path: ["tooling", "bad", "env", "LANDO_X"] }],
  },
  {
    label: "malformed service tooling",
    canonical: contributedService,
    local: "",
    fragment: "",
    paths: [["tooling", "contributed", "wrapper"]],
    sources: [{ file: ".lando.yml", layer: "canonical", path: ["services", "web", "type"] }],
  },
  ...["false", "\n    disabled: true"].map((disabled) => ({
    label: `disabled service tooling ${disabled}`,
    canonical: contributedService,
    local: `tooling:\n  contributed: ${disabled}\n`,
    fragment: "",
    paths: [],
    sources: [],
  })),
  {
    label: "healthy dynamic flag overrides defaults service",
    canonical:
      "toolingDefaults:\n  service: ':missing'\ntooling:\n  healthy:\n    cmd: echo tool\n    service: ':target'\n    flags:\n      target:\n        default: web\n",
    local: "",
    fragment: "",
    paths: [],
    sources: [],
  },
])("lint attributes $label (#2325)", async ({ canonical, local, fragment, paths, sources }) => {
  const root = await mkdtemp(join(tmpdir(), "lando-declarations-source-"));
  try {
    await writeFile(join(root, ".lando.yml"), `name: declarations\n${canonical}`);
    if (local) await writeFile(join(root, ".lando.local.yml"), local);
    if (fragment) await writeFile(join(root, "tasks.yml"), fragment);
    const layers = Layer.mergeAll(
      registryLayer,
      Layer.succeed(PathsService, makeLandoPaths({ userCacheRoot: join(root, "cache") })),
      Layer.succeed(
        StateStore,
        makeStateStore({
          privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
        }),
      ),
    );
    const result = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(layers)));
    const findings = result.violations.filter(
      (issue) => issue.rule === "landofile.tooling" || issue.rule === "landofile.host-shell",
    );
    expect(result.valid).toBe(paths.length === 0);
    expect(findings.map((issue) => issue.path)).toEqual([...paths]);
    expect(findings.map((issue) => issue.source)).toEqual(
      sources.map((source) => ({ ...source, file: join(root, source.file) })),
    );
    expect(findings.map((issue) => issue.scopes)).toEqual(paths.map(() => ["effective"]));
    expect(JSON.stringify(findings)).not.toContain("hidden");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
