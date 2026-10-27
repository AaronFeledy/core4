import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layerWith as pluginRegistryLayer } from "@lando/engine/plugins/registry";
import { makeConfigTranslators } from "@lando/lando3";
import { configTranslators } from "@lando/lando4";
import { ServiceName } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import type { ConfigTranslatorShape } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import {
  AppConfigTranslateResultSchema,
  appConfigTranslate,
} from "../../src/cli/commands/app-config-translate.ts";

// The bundled service catalog the CLI supplies through its plugin bootstrap.
const bundledCatalog = pluginRegistryLayer({ user: false, app: false });

test.each([
  [
    "custom:1",
    "Lando 3 kept this service's home, but Lando 4 won't keep it automatically: its image comes from the Landofile.",
  ],
  ["mariadb:11.4", undefined],
  ["docker.io/library/mariadb:11.4", undefined],
] as const)("assesses the final converted image %s in JSON preview", async (image, message) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-translate-home-"));
  try {
    await Bun.write(
      join(root, ".lando.yml"),
      "name: home-test\nservices:\n  database:\n    type: mariadb:11.4\n",
    );
    await Bun.write(
      join(root, ".lando.local.yml"),
      `services:\n  database:\n    overrides:\n      image: ${image}\n`,
    );
    const load = makeConfigTranslators({ decomposers: new Map(), redactor: createRedactor("secrets") }).get(
      "lando3",
    );
    if (load === undefined) throw new Error("Missing lando3 translator");
    const translator = await load();
    const encoderLoader = configTranslators.get("lando4");
    if (encoderLoader === undefined) throw new Error("Missing lando4 encoder");
    const encoder = await encoderLoader();
    // When
    const result = await Effect.runPromise(
      appConfigTranslate({ cwd: root, from: "lando3", translators: [translator, encoder] }).pipe(
        Effect.provide(bundledCatalog),
      ),
    );
    // Then
    expect(result.mode).toBe("preview");
    if (result.mode !== "preview") throw new Error("Expected preview");
    const reviews = result.diagnostics.filter(({ kind }) => kind === "needs-review");
    expect(reviews.map(({ message }) => message)).toEqual(message === undefined ? [] : [message]);
    if (message !== undefined)
      expect(reviews[0]?.remediation).toBe("Set services.database.home.path to keep a home.");
    const json = Schema.encodeSync(AppConfigTranslateResultSchema)(result);
    expect(JSON.parse(JSON.stringify(json))).toMatchObject({
      mode: "preview",
      translator: "lando3",
      target: "lando4",
      diagnostics: result.diagnostics,
    });
    expect(result.diagnostics.map(({ sourceId }) => sourceId)).toEqual(
      [...result.diagnostics]
        .sort((a, b) => result.files.indexOf(a.sourceId) - result.files.indexOf(b.sourceId))
        .map(({ sourceId }) => sourceId),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  [
    { type: "compose" },
    "Lando 3 kept this service's home, but Lando 4 won't keep it automatically: service type compose declares no image users.",
    "Set services.web.home.path to keep a home.",
  ],
  [
    { type: "mariadb:11.4", user: "nobody:staff" },
    "Lando 3 kept this service's home, but Lando 4 won't keep it automatically: service type mariadb:11.4 doesn't know where nobody's home is.",
    "Set services.web.home.path to keep a home.",
  ],
  [
    { type: "unknown-service" },
    "Lando 3 kept this service's home; Lando 4 can't confirm it will keep it automatically (service type unknown-service could not be resolved).",
    "After lando start, check the home row in lando info, or set services.web.home.path.",
  ],
] as const)(
  "appends and canonically orders catalog diagnostics for %j",
  async (service, message, remediation) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-home-diagnostics-"));
    try {
      await Bun.write(join(root, ".lando.yml"), "name: source\n");
      const encoderLoader = configTranslators.get("lando4");
      if (encoderLoader === undefined) throw new Error("Missing lando4 encoder");
      const encoder = await encoderLoader();
      const translator: ConfigTranslatorShape = {
        id: "source",
        summary: "Home intent source",
        inputKinds: ["landofile-document-set"],
        detect: () => Effect.succeed([]),
        translate: (input) => {
          const sourceId = input._tag === "recipe-request" ? input.sourceId : input.documents[0]?.sourceId;
          if (sourceId === undefined) throw new Error("Missing input source");
          return Effect.succeed({
            outputs: [
              {
                targetLayer: "canonical",
                sourceIds: [sourceId],
                fragment: { name: "home-test", services: { web: service } },
              },
            ],
            diagnostics: [
              {
                sourceId,
                keyPath: ["z"],
                kind: "rewritten",
                message: "Located rewrite",
                span: { start: { line: 1, column: 1 } },
              },
            ],
            deletions: [],
            expectations: [
              {
                _tag: "PersistedHome",
                sourceId,
                keyPath: ["services", "web"],
                service: ServiceName.make("web"),
              },
            ],
          });
        },
      };
      // When
      const result = await Effect.runPromise(
        appConfigTranslate({ cwd: root, from: "source", translators: [translator, encoder] }).pipe(
          Effect.provide(bundledCatalog),
        ),
      );
      // Then
      if (result.mode !== "preview") throw new Error("Expected preview");
      expect(result.diagnostics).toMatchObject([
        { kind: "needs-review", sourceId: ".lando.yml", keyPath: ["services", "web"], message, remediation },
        { kind: "rewritten", span: { start: { line: 1, column: 1 } } },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
