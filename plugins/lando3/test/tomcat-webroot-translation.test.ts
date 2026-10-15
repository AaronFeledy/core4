import { describe, expect, test } from "bun:test";
import { LEGACY_TAGGED } from "@lando/sdk/landofile";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect } from "effect";
import { lowerCatalogCommon } from "../src/lower-catalog-common.ts";
import type { ServiceLoweringContext } from "../src/lowering-contract.ts";
import { makeLando3ConfigTranslator } from "../src/translator.ts";
import { document, documentSet } from "./fixtures/fake-decomposers.ts";

const ctx: ServiceLoweringContext = {
  serviceName: "java",
  keyPath: ["services", "java"],
  fallbackSourceId: ".lando.yml",
  occurrenceAt: () => undefined,
  topLevel: { excludes: [], includes: [] },
};
const taggedRoot = { [LEGACY_TAGGED]: true, tag: "!load", value: "deploy-root.txt" };
const translate = (text: string) =>
  Effect.runPromise(
    makeLando3ConfigTranslator({ decomposers: new Map(), redactor: createRedactor("secrets") }).translate(
      documentSet([document(".lando.yml", text)]),
    ),
  );

describe("Tomcat legacy webroot lowering", () => {
  test.each([undefined, null, 42])("preserves an authored non-string webroot %j", (webroot) => {
    // Given: an authored value that cannot be joined as a literal path.
    const service = { type: "tomcat", webroot };
    // When: the service is lowered.
    const result = lowerCatalogCommon(service, ctx);
    // Then: the value survives unchanged with ROOT-directory remediation.
    expect(result.patch).toEqual({ type: "tomcat", webroot });
    expect(result.patch).toHaveProperty("webroot");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        kind: "needs-review",
        keyPath: [...ctx.keyPath, "webroot"],
        remediation: expect.stringContaining("<legacy root>/webapps/ROOT"),
      }),
    ]);
  });

  for (const app_mount of [false, "disabled", "off"]) {
    test.each([{}, { webroot: "target/app" }, { webroot: "/site" }, { webroot: taggedRoot }])(
      `omits webroot for app_mount ${app_mount} with %j`,
      (definition) => {
        // Given: a legacy Tomcat service without an app-code mount.
        const service = { type: "tomcat", app_mount, ...definition };
        // When: the service is lowered.
        const result = lowerCatalogCommon(service, ctx);
        // Then: no relative root is invented and image-provided content needs review.
        expect(result.patch).toEqual({ type: "tomcat", appMount: false });
        expect(result.diagnostics).toEqual([
          expect.objectContaining({
            kind: "needs-review",
            keyPath: [...ctx.keyPath, "webroot"],
            remediation: expect.stringContaining("absolute webroot"),
          }),
          expect.objectContaining({ kind: "rewritten", keyPath: [...ctx.keyPath, "app_mount"] }),
        ]);
      },
    );
  }

  test.each(["!load", "!import"])(
    "reports a parsed %s webroot as unsupported without emitting its marker",
    async (tag) => {
      // Given: a tagged webroot referring to a file that conversion must not read.
      const text = `services:\n  java:\n    type: tomcat:10\n    webroot: ${tag} deploy-root.txt\n`;
      // When: a complete legacy document is translated.
      const result = await translate(text);
      // Then: unsupported references cannot enter native authoring schemas.
      expect(result.outputs.map(({ fragment }) => fragment)).toEqual([
        {
          services: {
            java: {
              type: "tomcat:10",
            },
          },
        },
      ]);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ kind: "unsupported", keyPath: [...ctx.keyPath, "webroot"] }),
      ]);
    },
  );

  test.each([false, "disabled", "off"])(
    "translates app_mount %s without a relative webroot",
    async (appMount) => {
      // Given: a legacy document that disables its Tomcat app mount.
      const text = `services: {java: {type: "tomcat:10", app_mount: ${appMount}}}`;
      // When: the complete document is translated.
      const result = await translate(text);
      // Then: only appMount is emitted and an absolute image webroot is requested.
      expect(result.outputs.map(({ fragment }) => fragment)).toEqual([
        { services: { java: { type: "tomcat:10", appMount: false } } },
      ]);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          kind: "needs-review",
          keyPath: [...ctx.keyPath, "webroot"],
          remediation: expect.stringContaining("absolute webroot"),
        }),
      );
    },
  );
});
