import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import { PluginDescriptorMismatchError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";
import { plugin as mustachePlugin } from "@lando/template-mustache";

import { makePluginCapabilityIndex } from "../../src/plugins/module-set.ts";

const makeSubscriberModule = (name: string, subscriberId: string): LandoPluginModule => ({
  name,
  manifest: Schema.decodeSync(PluginManifest)({
    name,
    version: "1.0.0",
    api: 4,
    subscribers: [
      { id: subscriberId, selectors: [{ family: "cli-command-terminal" }], module: "./subscriber.ts" },
    ],
  }),
  subscriberFactoryLoaders: new Map([[subscriberId, async () => undefined]]),
});

describe("makePluginCapabilityIndex", () => {
  test("aggregates capability maps and manifests from fake modules", () => {
    // Given: two fake modules with distinct subscriber factories.
    const modules = [
      makeSubscriberModule("@lando/first", "first-subscriber"),
      makeSubscriberModule("@lando/second", "second-subscriber"),
    ];

    // When: a capability index is built.
    const result = makePluginCapabilityIndex(modules);

    // Then: all capabilities and manifests are preserved in module order.
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect([...result.right.subscriberFactoryLoaders.keys()]).toEqual([
        "first-subscriber",
        "second-subscriber",
      ]);
      expect(result.right.manifests).toEqual(modules.map((module) => module.manifest));
    }
  });

  test("rejects duplicate contribution ids across modules", () => {
    // Given: two modules declaring and providing the same subscriber id.
    const modules = [
      makeSubscriberModule("@lando/first", "shared-subscriber"),
      makeSubscriberModule("@lando/second", "shared-subscriber"),
    ];

    // When: a capability index is built.
    const result = makePluginCapabilityIndex(modules);

    // Then: the duplicate is a typed descriptor mismatch.
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(PluginDescriptorMismatchError);
      expect(result.left.pluginName).toBe("@lando/second");
      expect(result.left.kind).toBe("subscribers");
      expect(result.left.provided).toEqual(["shared-subscriber"]);
    }
  });

  test("rejects manifest and descriptor ids that do not match", () => {
    // Given: a manifest declaring one engine while its descriptor provides another.
    const templateEngines = mustachePlugin.templateEngines;
    if (templateEngines === undefined) throw new Error("Mustache descriptor has no template engines.");
    const templateEngine = templateEngines.get("mustache");
    if (templateEngine === undefined) throw new Error("Mustache descriptor has no mustache engine.");
    const module: LandoPluginModule = {
      name: "@lando/mismatch",
      manifest: Schema.decodeSync(PluginManifest)({
        name: "@lando/mismatch",
        version: "1.0.0",
        api: 4,
        contributes: { templateEngines: ["declared-engine"] },
      }),
      templateEngines: new Map([["provided-engine", templateEngine]]),
    };

    // When: a capability index is built.
    const result = makePluginCapabilityIndex([module]);

    // Then: the declared and provided ids are reported with remediation.
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(PluginDescriptorMismatchError);
      expect(result.left.pluginName).toBe("@lando/mismatch");
      expect(result.left.kind).toBe("templateEngines");
      expect(result.left.declared).toEqual(["declared-engine"]);
      expect(result.left.provided).toEqual(["provided-engine"]);
      expect(result.left.remediation.length).toBeGreaterThan(0);
    }
  });
});
