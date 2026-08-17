import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import { plugin as mkcertPlugin } from "@lando/ca-mkcert";
import { PluginDescriptorMismatchError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";
import { plugin as mustachePlugin } from "@lando/template-mustache";

import { makePluginCapabilityIndex } from "@lando/engine/plugins/module-set";

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

  test("indexes certificate authority contribution layers", () => {
    const result = makePluginCapabilityIndex([mkcertPlugin]);

    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.certificateAuthorities.get("mkcert")).toBe(
        mkcertPlugin.certificateAuthorities?.get("mkcert"),
      );
    }
  });

  test("returns a typed mismatch when certificate authority ids disagree", () => {
    const caLayer = mkcertPlugin.certificateAuthorities?.get("mkcert");
    if (caLayer === undefined) throw new Error("mkcert descriptor has no certificate authority layer.");
    const module: LandoPluginModule = {
      name: "@lando/ca-mismatch",
      manifest: Schema.decodeSync(PluginManifest)({
        name: "@lando/ca-mismatch",
        version: "1.0.0",
        api: 4,
        contributes: {
          certificateAuthorities: [{ id: "declared-ca", module: "./src/ca.ts" }],
        },
      }),
      certificateAuthorities: new Map([["provided-ca", caLayer]]),
    };

    const result = makePluginCapabilityIndex([module]);

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(PluginDescriptorMismatchError);
      expect(result.left.kind).toBe("certificateAuthorities");
      expect(result.left.declared).toEqual(["declared-ca"]);
      expect(result.left.provided).toEqual(["provided-ca"]);
    }
  });

  test("returns a typed mismatch for duplicate certificate authority ids", () => {
    const caLayer = mkcertPlugin.certificateAuthorities?.get("mkcert");
    if (caLayer === undefined) throw new Error("mkcert descriptor has no certificate authority layer.");
    const makeModule = (name: string): LandoPluginModule => ({
      name,
      manifest: Schema.decodeSync(PluginManifest)({
        name,
        version: "1.0.0",
        api: 4,
        contributes: { certificateAuthorities: [{ id: "shared-ca", module: "./src/ca.ts" }] },
      }),
      certificateAuthorities: new Map([["shared-ca", caLayer]]),
    });

    const result = makePluginCapabilityIndex([makeModule("@lando/ca-first"), makeModule("@lando/ca-second")]);

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(PluginDescriptorMismatchError);
      expect(result.left.kind).toBe("certificateAuthorities");
      expect(result.left.pluginName).toBe("@lando/ca-second");
    }
  });

  test("rejects manifest command ids without matching executable loaders", () => {
    // Given
    const manifest = Schema.decodeSync(PluginManifest)({
      name: "@lando/command-mismatch",
      version: "1.0.0",
      api: 4,
      contributes: { commands: ["meta:declared"] },
    });
    const module = { name: manifest.name, manifest };

    // When
    const result = makePluginCapabilityIndex([module]);

    // Then
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.kind).toBe("commands");
      expect(result.left.declared).toEqual(["meta:declared"]);
      expect(result.left.provided).toEqual([]);
    }
  });
});
