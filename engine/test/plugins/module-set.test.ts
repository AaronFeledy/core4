import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import { plugin as mkcertPlugin } from "@lando/ca-mkcert";
import { ConfigTranslatorConflictError, PluginDescriptorMismatchError } from "@lando/sdk/errors";
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

describe("makePluginCapabilityIndex config translators", () => {
  const makeTranslatorModule = (name: string, translatorId: string): LandoPluginModule => ({
    name,
    manifest: Schema.decodeSync(PluginManifest)({
      name,
      version: "1.0.0",
      api: 4,
      contributes: {
        configTranslators: [{ id: translatorId, module: "./translator.ts", inputKinds: [translatorId] }],
      },
    }),
    configTranslators: new Map([
      [
        translatorId,
        () =>
          Promise.reject(new Error(`Translator ${translatorId} must not load while indexing.`)),
      ],
    ]),
  });

  test("indexes translator loaders in module order without invoking them", () => {
    // Given: two modules each contributing one lazy translator loader.
    const modules = [
      makeTranslatorModule("@lando/first", "first-translator"),
      makeTranslatorModule("@lando/second", "second-translator"),
    ];

    // When: the capability index is built.
    const result = makePluginCapabilityIndex(modules);

    // Then: the loaders are indexed by id in module order and never called.
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect([...result.right.configTranslators.keys()]).toEqual(["first-translator", "second-translator"]);
    }
  });

  test("rejects duplicate translator ids naming both producers with no winner", () => {
    // Given: two modules contributing the same translator id.
    const modules = [
      makeTranslatorModule("@lando/first", "lando3"),
      makeTranslatorModule("@lando/second", "lando3"),
    ];

    // When: the capability index is built.
    const result = makePluginCapabilityIndex(modules);

    // Then: the collision is tagged and names both producing plugins.
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ConfigTranslatorConflictError);
      if (result.left instanceof ConfigTranslatorConflictError) {
        expect(result.left.id).toBe("lando3");
        expect(result.left.translators).toEqual(["@lando/first", "@lando/second"]);
      }
    }
  });

  test("rejects manifest translator ids that do not match descriptor loaders", () => {
    // Given: a manifest declaring one translator while the descriptor provides another.
    const declared = makeTranslatorModule("@lando/mismatch", "declared");
    const module: LandoPluginModule = {
      ...declared,
      configTranslators: new Map([["provided", () => Promise.reject(new Error("unused"))]]),
    };

    // When: the capability index is built.
    const result = makePluginCapabilityIndex([module]);

    // Then: the mismatch is a typed descriptor error for configTranslators.
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(PluginDescriptorMismatchError);
      if (result.left instanceof PluginDescriptorMismatchError) {
        expect(result.left.kind).toBe("configTranslators");
        expect(result.left.declared).toEqual(["declared"]);
        expect(result.left.provided).toEqual(["provided"]);
      }
    }
  });
});
