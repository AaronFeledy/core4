import { Effect, Schema } from "effect";

import { describe, expect, test } from "bun:test";

import { PluginDescriptorMismatchError } from "@lando/sdk/errors";
import { AbsolutePath, type AppPlan } from "@lando/sdk/schema";
import { AppPlanSanitizer, ContainerHelperAssets } from "@lando/sdk/services";

describe("AppPlanSanitizer tag", () => {
  test("resolves via Effect.provideService roundtrip", async () => {
    const plan = { id: "demo" } as unknown as AppPlan;
    const sanitized = { id: "clean" } as unknown as AppPlan;

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sanitizer = yield* AppPlanSanitizer;
        return sanitizer.sanitizeForPersistence(plan);
      }).pipe(
        Effect.provideService(AppPlanSanitizer, {
          sanitizeForPersistence: (input) => {
            expect(input).toBe(plan);
            return sanitized;
          },
        }),
      ),
    );

    expect(result).toBe(sanitized);
  });
});

describe("ContainerHelperAssets tag", () => {
  test("resolves via Effect.provideService roundtrip", async () => {
    const target = { os: "linux", arch: "x64" } as const;
    const helper = { target, digest: "1".repeat(64), path: AbsolutePath.make("/tmp/lando-container-helper") };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const assets = yield* ContainerHelperAssets;
        return yield* assets.resolve(target);
      }).pipe(
        Effect.provideService(ContainerHelperAssets, {
          resolve: () => Effect.succeed(helper),
        }),
      ),
    );

    expect(result).toBe(helper);
  });
});

describe("PluginDescriptorMismatchError", () => {
  test("constructs with _tag and round-trips through schema encode/decode", () => {
    const error = new PluginDescriptorMismatchError({
      pluginName: "@lando/provider-lando",
      kind: "requires",
      declared: ["AppPlanSanitizer"],
      provided: ["ContainerHelperAssets"],
      message: "Plugin descriptor requires do not match provided capabilities.",
      remediation: "Align the plugin descriptor requires with the capabilities core provides.",
    });

    expect(error._tag).toBe("PluginDescriptorMismatchError");
    expect(error.pluginName).toBe("@lando/provider-lando");
    expect(error.kind).toBe("requires");
    expect(error.declared).toEqual(["AppPlanSanitizer"]);
    expect(error.provided).toEqual(["ContainerHelperAssets"]);

    const encoded = Schema.encodeSync(PluginDescriptorMismatchError)(error);
    expect(encoded._tag).toBe("PluginDescriptorMismatchError");
    expect(encoded.pluginName).toBe("@lando/provider-lando");
    expect(encoded.declared).toEqual(["AppPlanSanitizer"]);
    expect(encoded.provided).toEqual(["ContainerHelperAssets"]);

    const decoded = Schema.decodeUnknownSync(PluginDescriptorMismatchError)(encoded);
    expect(decoded._tag).toBe("PluginDescriptorMismatchError");
    expect(decoded.message).toBe(error.message);
    expect(decoded.remediation).toBe(error.remediation);
    expect(decoded.declared).toEqual(["AppPlanSanitizer"]);
    expect(decoded.provided).toEqual(["ContainerHelperAssets"]);
  });
});
