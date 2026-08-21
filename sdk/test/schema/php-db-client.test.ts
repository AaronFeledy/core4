import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";
import { PhpServiceConfig } from "@lando/sdk/schema/services/php";

const strictDecode = (schema: Schema.Schema.AnyNoContext, input: unknown) =>
  Schema.decodeUnknownEither(schema, { onExcessProperty: "error" })(input);

describe("PHP db_client schema", () => {
  test("Given omitted db_client, when strictly decoding ServiceConfig, then it succeeds", () => {
    const result = strictDecode(ServiceConfig, { type: "php:8.3" });
    expect(result._tag).toBe("Right");
  });

  test("Given db_client auto, when decoding PhpServiceConfig, then it succeeds", () => {
    const result = strictDecode(PhpServiceConfig, { type: "php:8.3", db_client: "auto" });
    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right.db_client).toBe("auto");
    }
  });

  test("Given db_client false, when strictly decoding ServiceConfig, then it succeeds", () => {
    const result = strictDecode(ServiceConfig, { type: "php:8.3", db_client: false });
    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right.db_client).toBe(false);
    }
  });

  test("Given an explicit family version, when decoding PhpServiceConfig, then it succeeds", () => {
    const result = strictDecode(PhpServiceConfig, { type: "php:8.3", db_client: "mariadb:11.4" });
    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right.db_client).toBe("mariadb:11.4");
    }
  });

  test("Given db_client true, when strictly decoding ServiceConfig, then it fails", () => {
    const result = strictDecode(ServiceConfig, { type: "php:8.3", db_client: true });
    expect(result._tag).toBe("Left");
  });

  test("Given a db_client array, when decoding PhpServiceConfig, then it fails", () => {
    const result = strictDecode(PhpServiceConfig, { type: "php:8.3", db_client: ["mysql:8.0"] });
    expect(result._tag).toBe("Left");
  });

  test("Given a db_client object, when strictly decoding ServiceConfig, then it fails", () => {
    const result = strictDecode(ServiceConfig, { type: "php:8.3", db_client: { family: "mysql" } });
    expect(result._tag).toBe("Left");
  });

  test("Given decoded ServiceConfig with db_client, when decoding again strictly, then it round-trips", () => {
    const first = Schema.decodeUnknownSync(ServiceConfig)({ type: "php:8.3", db_client: "mariadb:11.4" });
    const second = Schema.decodeUnknownEither(ServiceConfig, { onExcessProperty: "error" })(first);
    expect(second._tag).toBe("Right");
    if (second._tag === "Right") {
      expect(second.right.db_client).toBe("mariadb:11.4");
    }
  });
});
