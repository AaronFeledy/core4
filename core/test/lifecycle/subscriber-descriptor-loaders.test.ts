import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Schema } from "effect";

import { PluginLoadError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { PluginManifest, SubscriberManifestEntry } from "@lando/sdk/schema";

import type { IndexedSubscriber } from "@lando/engine/lifecycle/subscriber-index";
import { loadSubscriberFactory } from "@lando/engine/lifecycle/subscribers";

const descriptorFixture = (): {
  readonly manifest: PluginManifest;
  readonly subscriber: IndexedSubscriber;
} => {
  const entry = Schema.decodeUnknownSync(SubscriberManifestEntry)({
    id: "descriptor-subscriber",
    selectors: [{ event: "message.info" }],
    module: "./descriptor-subscriber.ts",
  });
  const manifest = Schema.decodeUnknownSync(PluginManifest)({
    name: "@example/descriptor-subscriber",
    version: "1.0.0",
    api: 4,
    subscribers: [entry],
  });
  return {
    manifest,
    subscriber: { pluginName: String(manifest.name), entry },
  };
};

describe("subscriber descriptor loaders", () => {
  test("loads a subscriber factory lazily from an injected descriptor module", async () => {
    // Given: a descriptor module whose lazy loader records evaluation.
    const fixture = descriptorFixture();
    let loads = 0;
    const pluginModule = {
      name: fixture.subscriber.pluginName,
      manifest: fixture.manifest,
      subscriberFactoryLoaders: new Map([
        [
          fixture.subscriber.entry.id,
          () => {
            loads += 1;
            return Promise.resolve(() => () => Effect.void);
          },
        ],
      ]),
    } satisfies LandoPluginModule;

    // When: factory resolution is constructed and then evaluated.
    const load = loadSubscriberFactory(fixture.subscriber, [pluginModule]);
    expect(loads).toBe(0);
    const exit = await Effect.runPromiseExit(load);

    // Then: the injected loader runs only during effect evaluation and yields the factory.
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(loads).toBe(1);
  });

  test("preserves the missing bundled subscriber loader failure for an injected descriptor", async () => {
    // Given: a matching descriptor module that omits its declared subscriber loader.
    const fixture = descriptorFixture();
    const pluginModule = {
      name: fixture.subscriber.pluginName,
      manifest: fixture.manifest,
    } satisfies LandoPluginModule;

    // When: factory resolution evaluates against the injected descriptors.
    const exit = await Effect.runPromiseExit(loadSubscriberFactory(fixture.subscriber, [pluginModule]));

    // Then: the existing tagged missing-registration failure is preserved.
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(PluginLoadError);
        expect(failure.value).toMatchObject({
          pluginName: fixture.subscriber.pluginName,
          message: `Bundled subscriber factory ${fixture.subscriber.entry.id} is not registered.`,
        });
      }
    }
  });
});
