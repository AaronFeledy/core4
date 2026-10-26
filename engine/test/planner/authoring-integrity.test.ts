import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLandofileFile } from "@lando/landofile/service";
import { type LoadScopedLandofile, PortNumber, ServiceName } from "@lando/sdk/schema";
import { PluginRegistry, SecretStore, type ServiceType } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Schema } from "effect";
import { planApp } from "../../src/planner/assemble.ts";
import { effectiveToolingForPlan } from "../../src/planner/effective-tooling.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import { resolvePlanEnvironment } from "../environment-values.ts";

const serviceType: ServiceType = {
  id: "authoring-integrity",
  name: "authoring-integrity",
  base: "l337",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "l337" as const,
      normalizedConfig: {
        ...input.service,
        creds: { user: "", password: "{{ broken", database: "integrity" },
      },
      features: [],
      connection: {
        family: "postgres" as const,
        port: PortNumber.make(5544),
        creds: { user: "", password: "{{ broken", database: "integrity" },
      },
    }),
};
const plan = Effect.fnUntraced(
  function* (landofile: LoadScopedLandofile) {
    const registry = yield* PluginRegistry;
    return yield* planApp(
      { ...registry, loadServiceType: () => Effect.succeed(serviceType) },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      landofile,
      TestRuntimeProvider.capabilities,
    );
  },
  Effect.provide(PluginRegistryLayer.layerWith({ bundled: false }, [])),
);

const recipe = [
  "recipe:",
  "  id: lamp",
  '  version: "0.1.0"',
  "  producer:",
  "    sourceKind: bundled",
  "    packageName: '@lando/recipe-lamp'",
  "    recipeId: lamp",
  '    manifestVersion: "0.1.0"',
  `    contentDigest: "sha256:${"0".repeat(64)}"`,
  "  options:",
  '    empty: ""',
  '    literal: "$${secret:TEST}"',
].join("\n");

test.each([
  ["$${secret:TEST}", "${secret:TEST}", []],
  ["{{ recipe.empty }}$${secret:TEST}", "${secret:TEST}", []],
  ["{{ default(app.name, '') == 'integrity' ? '' : 'bad' }}$${secret:TEST}", "${secret:TEST}", []],
  ["{{ services.db.creds.user }}$${secret:TEST}", "${secret:TEST}", []],
  ["{{ recipe.literal }}", "$${secret:TEST}", []],
  ["{{ load('./payload.txt') }}", "${secret:TEST}", []],
  ["{{ import('./payload.json').value.TOKEN }}", "${secret:TEST}", []],
  ["${secret:TEST}", "resolved-from-store", ["TEST"]],
] as const)(
  "keeps secret provenance through load, plan and provider handoff: %s",
  async (authored, expected, calls) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-authoring-secret-"));
    try {
      await writeFile(join(root, "payload.txt"), "${secret:TEST}");
      await writeFile(join(root, "payload.json"), JSON.stringify({ TOKEN: "${secret:TEST}" }));
      const file = join(root, ".lando.yml");
      await writeFile(
        file,
        [
          "name: integrity",
          recipe,
          "services:",
          "  db:",
          `    type: ${serviceType.id}`,
          "    home: false",
          "  web:",
          `    type: ${serviceType.id}`,
          "    home: false",
          "    environment:",
          `      TOKEN: ${JSON.stringify(authored)}`,
        ].join("\n"),
      );
      const requested: string[] = [];
      const store = SecretStore.of({
        id: "test",
        get: (key) => {
          requested.push(key);
          return Effect.succeed("resolved-from-store");
        },
        has: () => Effect.succeed(true),
        list: Effect.succeed([]),
      });
      // When
      const loaded = await Effect.runPromise(loadLandofileFile(file));
      const app = await Effect.runPromise(plan(loaded));
      const overrides = await Effect.runPromise(
        resolvePlanEnvironment(app).pipe(Effect.provideService(SecretStore, store)),
      );
      const web = ServiceName.make("web");
      const environment = overrides[web];
      // Then
      expect(requested).toEqual([...calls]);
      expect(environment?.TOKEN).toBe(expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([
  ["$${HOME}", "${HOME}"],
  ["{{{{", "{{"],
  ["{{ recipe.empty }}{{ app.name }}-{{ services.db.creds.user }}-$${HOME}-{{{{", "integrity--${HOME}-{{"],
  ["{{ services.db.creds.password }}", "{{ broken"],
  ["{{ load('./literal.txt') }}", "$${HOME} {{{{ {{ broken ${ONLY}"],
] as const)("renders runtime text exactly once: %s", async (authored, expected) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-authoring-render-"));
  try {
    const file = join(root, ".lando.yml");
    await writeFile(join(root, "literal.txt"), "$${HOME} {{{{ {{ broken ${ONLY}");
    await writeFile(
      file,
      [
        "name: integrity",
        recipe,
        "services:",
        "  db:",
        `    type: ${serviceType.id}`,
        "    home: false",
        "tooling:",
        "  check:",
        `    cmd: ${JSON.stringify(authored)}`,
      ].join("\n"),
    );
    // When
    const loaded = await Effect.runPromise(loadLandofileFile(file));
    const app = await Effect.runPromise(plan(loaded));
    // Then
    expect(effectiveToolingForPlan(app)?.check?.cmd).toBe(expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
