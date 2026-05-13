import { describe, expect, test } from "bun:test";

import { PLUGIN_NAME } from "../src/index.ts";

describe("service-lando plugin test discovery", () => {
  test("runs plugin tests from plugins/*/test", () => {
    expect(PLUGIN_NAME).toBe("@lando/service-lando");
  });
});
