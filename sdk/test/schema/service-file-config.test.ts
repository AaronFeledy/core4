import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import * as SDK from "@lando/sdk/schema";

describe("ServiceFileConfig", () => {
  test("preserves config.server when decoding ServiceConfigInput", () => {
    // Given a mysql service with an app-relative config.server path,
    // when decoded through ServiceConfigInput,
    // then config.server is preserved.
    const decoded = Schema.decodeUnknownSync(SDK.ServiceConfigInput)({
      type: "mysql",
      config: { server: "./config/my.cnf" },
    });
    expect(decoded).toHaveProperty("config.server", "./config/my.cnf");
  });

  test("preserves config.dir when decoding ServiceConfigInput", () => {
    // Given a solr service with an app-relative config.dir path,
    // when decoded through ServiceConfigInput,
    // then config.dir is preserved.
    const decoded = Schema.decodeUnknownSync(SDK.ServiceConfigInput)({
      type: "solr",
      config: { dir: "./solr/conf" },
    });
    expect(decoded).toHaveProperty("config.dir", "./solr/conf");
  });

  test("rejects non-string config.server", () => {
    // Given config.server as a number,
    // when decoded,
    // then report a schema failure.
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(SDK.ServiceConfigInput)({
          type: "mysql",
          config: { server: 1 },
        }),
      ),
    ).toBe(true);
  });
});
