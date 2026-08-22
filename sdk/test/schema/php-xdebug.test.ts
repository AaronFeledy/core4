import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";
import { PhpServiceConfig } from "@lando/sdk/schema/services/php";

const strictDecode = (schema: Schema.Schema.AnyNoContext, input: unknown) =>
  Schema.decodeUnknownEither(schema, { onExcessProperty: "error" })(input);

describe("PHP xdebug schema", () => {
  test("Given xdebug true, when decoding PhpServiceConfig, then it succeeds", () => {
    const result = strictDecode(PhpServiceConfig, { type: "php:8.3", xdebug: true });
    expect(result._tag).toBe("Right");
  });

  test("Given xdebug false, when strictly decoding ServiceConfig, then it succeeds", () => {
    const result = strictDecode(ServiceConfig, { type: "php:8.3", xdebug: false });
    expect(result._tag).toBe("Right");
  });

  test("Given a mode string, when decoding PhpServiceConfig, then it succeeds", () => {
    const result = strictDecode(PhpServiceConfig, { type: "php:8.3", xdebug: "debug,develop" });
    expect(result._tag).toBe("Right");
  });
});
