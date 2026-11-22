import { describe, expect, test } from "bun:test";
import { ServiceConfig } from "@lando/sdk/schema";
import { PhpServiceConfig } from "@lando/sdk/schema/services/php";
import { Schema } from "effect";

const strictDecode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown) =>
  Schema.decodeUnknownResult(schema, { onExcessProperty: "error" })(input);

describe("PHP dbClient schema", () => {
  test("Given omitted dbClient, when strictly decoding ServiceConfig, then it succeeds", () => {
    const result = strictDecode(ServiceConfig, { type: "php:8.3" });
    expect(result._tag).toBe("Success");
  });

  test("Given dbClient auto, when decoding PhpServiceConfig, then it succeeds", () => {
    const result = strictDecode(PhpServiceConfig, { type: "php:8.3", dbClient: "auto" });
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.success.dbClient).toBe("auto");
    }
  });

  test("Given dbClient false, when strictly decoding ServiceConfig, then it succeeds", () => {
    const result = strictDecode(ServiceConfig, { type: "php:8.3", dbClient: false });
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.success.dbClient).toBe(false);
    }
  });

  test("Given an explicit family version, when decoding PhpServiceConfig, then it succeeds", () => {
    const result = strictDecode(PhpServiceConfig, { type: "php:8.3", dbClient: "mariadb:11.4" });
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.success.dbClient).toBe("mariadb:11.4");
    }
  });

  test("Given dbClient true, when strictly decoding ServiceConfig, then it fails", () => {
    const result = strictDecode(ServiceConfig, { type: "php:8.3", dbClient: true });
    expect(result._tag).toBe("Failure");
  });

  test("Given a dbClient array, when decoding PhpServiceConfig, then it fails", () => {
    const result = strictDecode(PhpServiceConfig, { type: "php:8.3", dbClient: ["mysql:8.0"] });
    expect(result._tag).toBe("Failure");
  });

  test("Given a dbClient object, when strictly decoding ServiceConfig, then it fails", () => {
    const result = strictDecode(ServiceConfig, { type: "php:8.3", dbClient: { family: "mysql" } });
    expect(result._tag).toBe("Failure");
  });

  test("Given decoded ServiceConfig with dbClient, when decoding again strictly, then it round-trips", () => {
    const first = Schema.decodeUnknownSync(ServiceConfig)({ type: "php:8.3", dbClient: "mariadb:11.4" });
    const second = Schema.decodeUnknownResult(ServiceConfig, { onExcessProperty: "error" })(first);
    expect(second._tag).toBe("Success");
    if (second._tag === "Success") {
      expect(second.success.dbClient).toBe("mariadb:11.4");
    }
  });
});
