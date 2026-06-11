import { Schema } from "effect";

import { PluginTrustState } from "../../src/schema/plugin-trust.ts";

describe("PluginTrustState", () => {
  test("accepts sorted unique plugin and authoring-root trust lists", () => {
    const result = Schema.decodeUnknownEither(PluginTrustState)({
      trustedPlugins: ["@lando/plugin-node", "@lando/plugin-php"],
      trustedAuthoringRoots: ["/opt/lando/a", "/opt/lando/b"],
    });

    expect(result._tag).toBe("Right");
  });

  test("rejects duplicate or unsorted trust entries", () => {
    const duplicate = Schema.decodeUnknownEither(PluginTrustState)({
      trustedPlugins: ["@lando/plugin-php", "@lando/plugin-php"],
      trustedAuthoringRoots: [],
    });
    const unsorted = Schema.decodeUnknownEither(PluginTrustState)({
      trustedPlugins: ["@lando/plugin-php", "@lando/plugin-node"],
      trustedAuthoringRoots: ["/opt/lando/b", "/opt/lando/a"],
    });

    expect(duplicate._tag).toBe("Left");
    expect(unsorted._tag).toBe("Left");
  });
});
