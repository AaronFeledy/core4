import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Context, Effect, Layer, Schema } from "effect";

import * as caMkcert from "@lando/ca-mkcert";
import * as fileSyncMutagen from "@lando/file-sync-mutagen";
import * as lando3 from "@lando/lando3";
import * as lando4 from "@lando/lando4";
import * as notifyLando from "@lando/notify-lando";
import * as providerDocker from "@lando/provider-docker";
import * as providerLando from "@lando/provider-lando";
import * as providerPodman from "@lando/provider-podman";
import * as proxyTraefik from "@lando/proxy-traefik";
import * as rendererLando from "@lando/renderer-lando";
import * as serviceLando from "@lando/service-lando";
import * as sqlPlugin from "@lando/sql";
import * as sshAgent from "@lando/ssh-agent";
import * as templateHandlebars from "@lando/template-handlebars";
import * as templateMustache from "@lando/template-mustache";

import { ConfigTranslateInput } from "@lando/sdk/schema";
import { ConfigService, Logger } from "@lando/sdk/services";

import { PluginRegistry, PluginRegistryLive } from "@lando/engine/plugins/registry";
import { BUNDLED_PLUGIN_MODULES } from "../../src/plugins/generated/bundled.ts";
import { BUNDLED_RENDERER_MODULES } from "../../src/plugins/generated/renderers.ts";
import { loadLando3TranslatorPorts } from "../../src/recipes/lando3-ports.ts";

const EXPECTED_BUNDLED_PLUGIN_MODULES = [
  providerLando.plugin,
  providerDocker.plugin,
  providerPodman.plugin,
  serviceLando.plugin,
  rendererLando.plugin,
  notifyLando.plugin,
  fileSyncMutagen.plugin,
  caMkcert.plugin,
  proxyTraefik.plugin,
  sshAgent.plugin,
  templateHandlebars.plugin,
  templateMustache.plugin,
  sqlPlugin.plugin,
  lando4.plugin,
  lando3.plugin,
];

const generatedDir = resolve(import.meta.dirname, "../../src/plugins/generated");
const generatorPath = resolve(import.meta.dirname, "../../../scripts/build-bundled-plugins.ts");
const notifyIndexPath = resolve(import.meta.dirname, "../../../plugins/notify-lando/src/index.ts");
const rendererIndexPath = resolve(import.meta.dirname, "../../../plugins/renderer-lando/src/index.ts");

describe("bundled plugin descriptor tables", () => {
  test("exports every bundled plugin descriptor in ship-list order", async () => {
    expect(BUNDLED_PLUGIN_MODULES).toHaveLength(15);
    expect(BUNDLED_PLUGIN_MODULES.map((plugin) => plugin.name)).toEqual(
      EXPECTED_BUNDLED_PLUGIN_MODULES.map((plugin) => plugin.name),
    );
    for (const [index, expected] of EXPECTED_BUNDLED_PLUGIN_MODULES.entries()) {
      const actual = BUNDLED_PLUGIN_MODULES[index];
      if (expected === lando3.plugin) {
        // Only loader closure identity differs from the package factory's output.
        const composed = lando3.makeLando3Plugin(loadLando3TranslatorPorts);
        expect({ ...actual, configTranslators: undefined }).toEqual({
          ...composed,
          configTranslators: undefined,
        });
        expect(actual?.name).toBe(lando3.PLUGIN_NAME);
        expect(actual?.manifest).toBe(lando3.manifest);
        expect([...(actual?.configTranslators?.keys() ?? [])]).toEqual(["lando3"]);
        expect(actual?.configTranslators?.get("lando3")).toBeFunction();
        const translator = await actual?.configTranslators?.get("lando3")?.();
        const packageTranslator = await composed.configTranslators?.get("lando3")?.();
        if (translator === undefined || packageTranslator === undefined)
          throw new Error("lando3 translator did not load");
        expect(translator.id).toBe("lando3");
        const text = "name: bundled-proof\n";
        const input = Schema.decodeUnknownSync(ConfigTranslateInput)({
          _tag: "landofile-document-set",
          documents: [
            {
              sourceId: ".lando.yml",
              layerId: "canonical",
              path: ".lando.yml",
              mediaType: "application/yaml",
              contentDigest: `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`,
              bytes: Buffer.from(text).toString("base64"),
            },
          ],
          mode: "full",
          selectedSourceIds: [".lando.yml"],
          currentLowerV4Fragments: [],
          writableLayerIds: ["canonical"],
        });
        const result = await Effect.runPromise(translator.translate(input));
        expect(result).toEqual(await Effect.runPromise(packageTranslator.translate(input)));
        expect(result.outputs.map(({ fragment }) => fragment)).toEqual([{ name: "bundled-proof" }]);
      } else {
        expect(actual).toBe(expected);
      }
    }
    expect(BUNDLED_RENDERER_MODULES).toEqual([rendererLando.plugin]);

    const mkcertEntry = BUNDLED_PLUGIN_MODULES.find((plugin) => plugin.name === "@lando/ca-mkcert");
    expect(mkcertEntry?.certificateAuthorities?.get("mkcert")).toBe(
      caMkcert.plugin.certificateAuthorities?.get("mkcert"),
    );

    const serviceLandoEntry = BUNDLED_PLUGIN_MODULES.find((plugin) => plugin.name === "@lando/service-lando");
    expect(serviceLandoEntry?.globalServices?.get("mailpit")).toBe(
      serviceLando.globalServices.get("mailpit"),
    );

    const handlebarsEntry = BUNDLED_PLUGIN_MODULES.find(
      (plugin) => plugin.name === "@lando/template-handlebars",
    );
    expect(handlebarsEntry?.templateEngines?.get("handlebars")).toBe(
      templateHandlebars.templateEngines.get("handlebars"),
    );
    const mustacheEntry = BUNDLED_PLUGIN_MODULES.find((plugin) => plugin.name === "@lando/template-mustache");
    expect(mustacheEntry?.templateEngines?.get("mustache")).toBe(
      templateMustache.templateEngines.get("mustache"),
    );
  });

  test("loads the bundled subscriber factory from its descriptor", async () => {
    const notifyEntry = BUNDLED_PLUGIN_MODULES.find((plugin) => plugin.name === "@lando/notify-lando");
    const notifyFactory = await notifyEntry?.subscriberFactoryLoaders?.get("notify-command-terminal")?.();
    expect(typeof notifyFactory).toBe("function");
  });

  test("every bundled plugin manifest declares the @lando/core compatibility range", () => {
    for (const expected of EXPECTED_BUNDLED_PLUGIN_MODULES) {
      expect(expected.manifest.requires?.["@lando/core"]).toBe("^4.0.0");
    }
  });

  test("every bundled plugin manifest receives the omitted app bootstrap default", () => {
    // Given: bundled manifests remain unchanged and omit bootstrap declarations.
    const manifests = EXPECTED_BUNDLED_PLUGIN_MODULES.map((plugin) => plugin.manifest);

    // When: their decoded bootstrap levels are inspected.
    const bootstrapLevels = manifests.map(
      (manifest) => Object.getOwnPropertyDescriptor(manifest, "bootstrap")?.value,
    );

    // Then: all bundled plugins retain app-level subscriber coverage by default.
    expect(bootstrapLevels).toEqual(manifests.map(() => "app"));
  });

  test("generated bundled plugin descriptor tables are idempotent", async () => {
    const paths = [resolve(generatedDir, "bundled.ts"), resolve(generatedDir, "renderers.ts")];
    const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
    const proc = Bun.spawnSync([process.execPath, generatorPath], {
      cwd: resolve(import.meta.dirname, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const after = await Promise.all(paths.map((path) => readFile(path, "utf8")));

    expect(after).toEqual(before);
  });

  test("bundled subscriber module remains lazy behind a Bun-traceable literal importer", async () => {
    // Given: the package index and generated compiled-bundle descriptor table.
    const indexSource = await readFile(notifyIndexPath, "utf8");

    // When: their subscriber loading edges are inspected.
    const importsPolicyAtIndex = indexSource.includes('from "./notify.ts"');
    const hasLiteralLazyImport = indexSource.includes('import("./notify.ts")');

    // Then: manifest loading is side-effect free and Bun can trace the lazy policy module.
    expect(importsPolicyAtIndex).toBe(false);
    expect(hasLiteralLazyImport).toBe(true);
  });

  test("bundled renderer keeps OpenTUI prompt code behind a literal lazy import", async () => {
    // Given: the renderer package index and renderer-only descriptor table.
    const [indexSource, rendererTableSource] = await Promise.all([
      readFile(rendererIndexPath, "utf8"),
      readFile(resolve(generatedDir, "renderers.ts"), "utf8"),
    ]);

    // When: the renderer loading edges are inspected.
    const hasStaticPromptDriverImport = indexSource.includes('from "./opentui/prompt-driver.ts"');
    const hasLiteralPromptDriverImport = indexSource.includes('import("./opentui/prompt-driver.ts")');

    // Then: descriptor discovery stays OpenTUI-free until the prompt driver is requested.
    expect(rendererTableSource).not.toContain("@opentui/core");
    expect(hasStaticPromptDriverImport).toBe(false);
    expect(hasLiteralPromptDriverImport).toBe(true);
  });

  test("PluginRegistryLive lists and loads bundled manifests when external registries are empty", async () => {
    const userDataRoot = await mkdtemp(resolve(tmpdir(), "lando-bundled-registry-"));
    try {
      const registryLayer = PluginRegistryLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ConfigService, {
              load: Effect.succeed({ userDataRoot } as never),
              get: (key) =>
                Effect.succeed(key === "userDataRoot" ? (userDataRoot as never) : (undefined as never)),
            }),
            Layer.succeed(Logger, {
              debug: () => Effect.void,
              info: () => Effect.void,
              warn: () => Effect.void,
              error: () => Effect.void,
            }),
          ),
        ),
      );
      const context = await Effect.runPromise(Effect.scoped(Layer.build(registryLayer)));
      const registry = Context.get(context, PluginRegistry);
      const manifests = await Effect.runPromise(registry.list);
      const manifestNames: ReadonlyArray<string> = manifests.map((manifest) => String(manifest.name));
      expect(manifestNames).toEqual(EXPECTED_BUNDLED_PLUGIN_MODULES.map((plugin) => plugin.name));

      const manifest = await Effect.runPromise(registry.load("@lando/provider-docker"));
      const loadedName: string = String(manifest.name);
      expect(loadedName).toBe("@lando/provider-docker");

      const exit = await Effect.runPromiseExit(registry.load("@lando/not-bundled"));
      expect(exit._tag).toBe("Failure");
    } finally {
      await rm(userDataRoot, { recursive: true, force: true });
    }
  });
});
