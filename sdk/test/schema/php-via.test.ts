import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";
import { PhpServiceConfig } from "@lando/sdk/schema/services/php";

const strictDecode = (schema: Schema.Schema.AnyNoContext, input: unknown) =>
  Schema.decodeUnknownEither(schema, { onExcessProperty: "error" })(input);

describe("PHP via serving-mode schema", () => {
  test("Given PHP via fpm, when decoding PhpServiceConfig, then it succeeds", () => {
    const result = strictDecode(PhpServiceConfig, { type: "php:8.3", via: "fpm" });
    expect(result._tag).toBe("Right");
  });

  test("Given ServiceConfig via cli, when strictly decoding, then it succeeds", () => {
    const result = strictDecode(ServiceConfig, { type: "php:8.3", via: "cli" });
    expect(result._tag).toBe("Right");
  });
});
