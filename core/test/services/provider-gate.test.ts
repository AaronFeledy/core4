import { describe, expect, test } from "bun:test";

describe("provider integration test gate", () => {
  test.skipIf(!process.env.LANDO_TEST_PODMAN_SOCKET)(
    "only runs provider-touching integration checks when explicitly enabled",
    () => {
      expect(process.env.LANDO_TEST_PODMAN_SOCKET).toBeTruthy();
    },
  );
});
