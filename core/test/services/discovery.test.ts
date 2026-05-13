import { describe, expect, test } from "bun:test";

import { Logger } from "@lando/core/services";

describe("core service test discovery", () => {
  test("runs Effect-service tests from core/test/services", () => {
    expect(Logger.key).toBe("@lando/core/Logger");
  });
});
