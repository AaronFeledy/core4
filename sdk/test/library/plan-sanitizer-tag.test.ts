import { Effect, Schema } from "effect";

import { describe, expect, test } from "bun:test";

import { PluginDescriptorMismatchError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import { AppPlanSanitizer, LogFileHelperAssets } from "@lando/sdk/services";

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

describe("LogFileHelperAssets tag", () => {
  test("resolves via Effect.provideService roundtrip", async () => {
    const payloads: Readonly<Record<string, Uint8Array>> = {
      "linux-x64": new Uint8Array([1, 2, 3]),
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const assets = yield* LogFileHelperAssets;
        return yield* assets.payloads;
      }).pipe(
        Effect.provideService(LogFileHelperAssets, {
          payloads: Effect.succeed(payloads),
        }),
      ),
    );

    expect(result).toBe(payloads);
    expect(result["linux-x64"]).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("PluginDescriptorMismatchError", () => {
  test("constructs with _tag and round-trips through schema encode/decode", () => {
    const error = new PluginDescriptorMismatchError({
      pluginName: "@lando/provider-lando",
      kind: "requires",
      declared: ["AppPlanSanitizer"],
      provided: ["LogFileHelperAssets"],
      message: "Plugin descriptor requires do not match provided capabilities.",
      remediation: "Align the plugin descriptor requires with the capabilities core provides.",
    });

    expect(error._tag).toBe("PluginDescriptorMismatchError");
    expect(error.pluginName).toBe("@lando/provider-lando");
    expect(error.kind).toBe("requires");
    expect(error.declared).toEqual(["AppPlanSanitizer"]);
    expect(error.provided).toEqual(["LogFileHelperAssets"]);

    const encoded = Schema.encodeSync(PluginDescriptorMismatchError)(error);
    expect(encoded._tag).toBe("PluginDescriptorMismatchError");
    expect(encoded.pluginName).toBe("@lando/provider-lando");
    expect(encoded.declared).toEqual(["AppPlanSanitizer"]);
    expect(encoded.provided).toEqual(["LogFileHelperAssets"]);

    const decoded = Schema.decodeUnknownSync(PluginDescriptorMismatchError)(encoded);
    expect(decoded._tag).toBe("PluginDescriptorMismatchError");
    expect(decoded.message).toBe(error.message);
    expect(decoded.remediation).toBe(error.remediation);
    expect(decoded.declared).toEqual(["AppPlanSanitizer"]);
    expect(decoded.provided).toEqual(["LogFileHelperAssets"]);
  });
});
