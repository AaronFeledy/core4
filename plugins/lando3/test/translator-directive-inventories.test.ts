import { expect, test } from "bun:test";
import { isPlainRecord } from "@lando/sdk/landofile";
import { Effect } from "effect";
import { lando3ConfigTranslator } from "../src/translator.ts";
import { document, documentSet } from "./fixtures/fake-decomposers.ts";

test.each(["events", "endpoints", "member endpoints"])(
  "inventories overridden established maps for %s",
  async (inventory) => {
    // Given established native maps transported as wire overrides.
    const input = documentSet([
      document(".lando.dist.yml", "name: demo\nrecipe:\n  id: lamp\n"),
      document(
        ".lando.local.yml",
        "events:\n  post-start: [echo ready]\n  post-audit: [echo audited]\nproxy:\n  appserver: [appserver.demo:8080]\n",
      ),
    ]);
    // When the later legacy layer is converted.
    const result = await Effect.runPromise(
      lando3ConfigTranslator.translate({
        ...input,
        currentLowerV4Fragments: [
          {
            layerId: "dist",
            fragment: {
              name: "demo",
              recipe: {
                id: "lamp",
                version: "1.0.0",
                options: {},
                producer: {
                  sourceKind: "bundled",
                  packageName: "@lando/test-recipes",
                  recipeId: "lamp",
                  manifestVersion: "1.0.0",
                  contentDigest: `sha256:${"a".repeat(64)}`,
                },
              },
              services:
                inventory === "member endpoints"
                  ? {
                      appserver: {
                        _tag: "LandofileOverride",
                        value: {
                          image: "php:8.3",
                          endpoints: [{ _tag: "internal", protocol: "http", port: 80 }],
                        },
                      },
                    }
                  : {
                      _tag: "LandofileOverride",
                      value: {
                        appserver: {
                          image: "php:8.3",
                          endpoints: [{ _tag: "internal", protocol: "http", port: 80 }],
                        },
                      },
                    },
              tooling: {
                _tag: "LandofileOverride",
                value: { audit: { service: "appserver", cmd: "echo audit" } },
              },
            },
          },
        ],
      }),
    );
    // Then events name the real service and routes retain its existing endpoint.
    const fragment = result.outputs.find(({ targetLayer }) => targetLayer === "local")?.fragment;
    if (inventory === "events") {
      expect(fragment?.events).toEqual({
        "post-start": [{ cmd: "echo ready", service: "appserver" }],
        "post-audit": [{ cmd: "echo audited", service: "appserver" }],
      });
      return;
    }
    const services = fragment?.services;
    const appserver = isPlainRecord(services) ? services.appserver : undefined;
    expect(isPlainRecord(appserver) ? appserver.endpoints : undefined).toEqual([
      { _tag: "internal", protocol: "http", port: 80 },
      { _tag: "internal", protocol: "http", port: 8080 },
    ]);
  },
);

test("reset established inventories contribute no service or tooling names", async () => {
  // Given reset maps and a legacy event around the wrapper payload name.
  const input = documentSet([document(".lando.local.yml", "events:\n  post-value: [echo ignored]\n")]);
  // When the later layer is converted.
  const result = await Effect.runPromise(
    lando3ConfigTranslator.translate({
      ...input,
      currentLowerV4Fragments: [
        {
          layerId: "dist",
          fragment: {
            services: { _tag: "LandofileReset" },
            tooling: { _tag: "LandofileReset" },
          },
        },
      ],
    }),
  );
  // Then no event is retained for a nonexistent wrapper-derived tool.
  expect(
    result.outputs.some(({ fragment }) => isPlainRecord(fragment.events) && "post-value" in fragment.events),
  ).toBe(false);
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ kind: "dropped", keyPath: ["events", "post-value"] }),
  );
});
