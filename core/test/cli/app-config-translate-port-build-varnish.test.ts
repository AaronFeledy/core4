import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { appConfigLint } from "@lando/engine/operations/app-config-lint";
import { layerWith as pluginRegistryLayer } from "@lando/engine/plugins/registry";
import { makeConfigTranslators } from "@lando/lando3";
import { createRedactor } from "@lando/sdk/secrets";
import { serviceTypeFacts } from "@lando/service-lando";
import { Effect } from "effect";
import { withFixture } from "./translate-lando3-fixture.ts";

const bundledCatalog = pluginRegistryLayer({ user: false, app: false });
const loader = makeConfigTranslators({
  decomposers: new Map(),
  redactor: createRedactor("secrets"),
  serviceFacts: serviceTypeFacts(),
}).get("lando3");
if (loader === undefined) throw new Error("Missing Lando 3 translator");
const translator = await loader();

test.each([
  ["API-4 HTTP publication", "  web: {api: 4, type: lando, image: alpine:3.21, ports: ['5173:5173/http']}"],
  ["API-4 HTTPS publication", "  web: {api: 4, type: lando, image: alpine:3.21, ports: ['8443:443/https']}"],
  ["API-4 TCP publication", "  web: {api: 4, type: lando, image: alpine:3.21, ports: ['9000:80/tcp']}"],
  ["API-3 random publication", "  web: {type: lando, services: {image: alpine:3.21, ports: ['0:80']}}"],
  ["Varnish implicit backend", "  appserver: {type: nginx}\n  web: {type: varnish:6}"],
] as const)("passes bundled appConfigLint when translating %s", async (_name, services) => {
  await withFixture(async ({ root, run, translators }) => {
    // Given
    await rm(join(root, ".lando.recipe.yml"));
    await rm(join(root, ".lando.local.yml"));
    const file = join(root, ".lando.yml");
    await Bun.write(file, `name: corpus-fidelity\nservices:\n${services}\n`);
    // When
    const translated = await Effect.runPromise(
      run({ translators: translators.map((entry) => (entry.id === "lando3" ? translator : entry)) }),
    );
    if (translated.mode !== "preview") throw new Error("Expected translation preview");
    const target = translated.targets[0];
    if (target === undefined) throw new Error("Missing translated Landofile");
    await Bun.write(file, target.content);
    const lint = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(bundledCatalog)));
    // Then
    expect(translated.diagnostics.filter(({ kind }) => kind === "unsupported")).toEqual([]);
    expect(lint.valid).toBe(true);
    expect(lint.violations).toEqual([]);
  });
});

test("rejects mixed image and app build intent before producing invalid Lando 4", async () => {
  await withFixture(async ({ root, run, translators }) => {
    // Given
    await rm(join(root, ".lando.recipe.yml"));
    await rm(join(root, ".lando.local.yml"));
    await Bun.write(
      join(root, ".lando.yml"),
      "name: mixed-build\nservices: {web: {api: 4, type: lando, image: {imagefile: 'FROM alpine:3.21'}, build: {app: 'echo ready'}}}\n",
    );
    // When
    const translated = await Effect.runPromise(
      run({ translators: translators.map((entry) => (entry.id === "lando3" ? translator : entry)) }),
    );
    // Then
    if (translated.mode !== "preview") throw new Error("Expected translation preview");
    expect(translated.diagnostics).toContainEqual(
      expect.objectContaining({ kind: "unsupported", keyPath: ["services", "web", "build"] }),
    );
    expect(translated.diagnostics.filter(({ message }) => message.startsWith("Unclaimed"))).toEqual([]);
  });
});
