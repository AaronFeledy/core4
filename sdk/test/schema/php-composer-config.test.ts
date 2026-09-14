import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import * as SDK from "@lando/sdk/schema";

const strictDecode = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Schema.decodeUnknownEither(schema)(input, { onExcessProperty: "error" });

describe("PhpComposerConfig", () => {
  test("preserves the object form when decoding ServiceConfigInput", () => {
    // Given a PHP service authoring the additive composer object form,
    // when decoded through ServiceConfigInput,
    // then both version and packages survive.
    const decoded = Schema.decodeUnknownSync(SDK.ServiceConfigInput)({
      type: "php:8.3",
      composer: { version: "2", packages: { "phpstan/phpstan": "^1.11" } },
    });

    expect(decoded).toHaveProperty("composer.version", "2");
    expect(decoded).toHaveProperty("composer.packages", { "phpstan/phpstan": "^1.11" });
  });

  test("still preserves the string and false forms", () => {
    // Given the pre-existing composer spellings,
    // when decoded,
    // then they are unchanged by the additive object member.
    expect(
      Schema.decodeUnknownSync(SDK.ServiceConfigInput)({ type: "php:8.3", composer: "2.7.7" }),
    ).toHaveProperty("composer", "2.7.7");
    expect(
      Schema.decodeUnknownSync(SDK.ServiceConfigInput)({ type: "php:8.3", composer: false }),
    ).toHaveProperty("composer", false);
  });

  test("accepts an empty object, a version-only object, and a packages-only object", () => {
    // Given every partial spelling of the object form,
    // when strictly decoded,
    // then each succeeds because both members are optional.
    for (const composer of [{}, { version: "2" }, { packages: { "vendor/tool": "^1.0" } }]) {
      expect(strictDecode(SDK.ServiceConfigInput, { type: "php:8.3", composer })._tag).toBe("Right");
    }
  });

  test("round-trips its own decoded output under strict decoding", () => {
    // Given the Landofile pipeline decodes per file and again over the merged result,
    // when the canonical output is decoded a second time,
    // then it is accepted under both excess-property policies.
    const input = { type: "php:8.3", composer: { version: "2", packages: { "vendor/a": "^1" } } };
    const once = Schema.decodeUnknownSync(SDK.ServiceConfigInput)(input);
    const twice = Schema.decodeUnknownSync(SDK.ServiceConfigInput)(once);

    expect(twice).toEqual(once);
    expect(strictDecode(SDK.ServiceConfigInput, once)._tag).toBe("Right");
  });

  test("decodes the object form through PhpServiceConfig and LandofileShape", () => {
    // Given the published PHP catalog schema and the whole-file shape,
    // when the object form is strictly decoded through each,
    // then both accept it.
    expect(
      strictDecode(SDK.PhpServiceConfig, {
        type: "php:8.4",
        composer: { version: "2", packages: { "vendor/a": "^1" } },
      })._tag,
    ).toBe("Right");

    expect(
      Either.isRight(
        Schema.decodeUnknownEither(SDK.LandofileShape)({
          name: "composer-object",
          services: { appserver: { type: "php:8.4", composer: { packages: { "vendor/a": "^1" } } } },
        }),
      ),
    ).toBe(true);
  });

  test("rejects a non-string version, non-string package constraints, and unknown members", () => {
    // Given malformed object forms,
    // when decoded,
    // then each is refused by the schema.
    expect(
      Either.isLeft(Schema.decodeUnknownEither(SDK.ServiceConfigInput)({ composer: { version: 2 } })),
    ).toBe(true);
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(SDK.ServiceConfigInput)({
          composer: { packages: { "vendor/a": 1 } },
        }),
      ),
    ).toBe(true);
    expect(strictDecode(SDK.ServiceConfigInput, { composer: { nope: true } })._tag).toBe("Left");
  });
});

describe("ServiceConfig.globals", () => {
  test("preserves a node globals map when decoding ServiceConfigInput", () => {
    // Given a node service authoring global npm packages,
    // when decoded through ServiceConfigInput,
    // then the map survives verbatim.
    const decoded = Schema.decodeUnknownSync(SDK.ServiceConfigInput)({
      type: "node:22",
      globals: { "gulp-cli": "latest", yarn: "1.22.4" },
    });

    expect(decoded).toHaveProperty("globals", { "gulp-cli": "latest", yarn: "1.22.4" });
  });

  test("round-trips its own decoded output under strict decoding", () => {
    // Given the two-pass Landofile decode,
    // when the canonical output is decoded again,
    // then it is accepted under the strict excess-property policy.
    const once = Schema.decodeUnknownSync(SDK.ServiceConfigInput)({
      type: "node:22",
      globals: { yarn: "1.22.4" },
    });

    expect(strictDecode(SDK.ServiceConfigInput, once)._tag).toBe("Right");
  });

  test("rejects a globals array and non-string versions", () => {
    // Given globals authored as a list or with non-string versions,
    // when decoded,
    // then the schema refuses both.
    expect(Either.isLeft(Schema.decodeUnknownEither(SDK.ServiceConfigInput)({ globals: ["yarn"] }))).toBe(
      true,
    );
    expect(Either.isLeft(Schema.decodeUnknownEither(SDK.ServiceConfigInput)({ globals: { yarn: 1 } }))).toBe(
      true,
    );
  });
});
