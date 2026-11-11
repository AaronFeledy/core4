import { describe, expect, test } from "bun:test";

import { resolveLiveProviderSocket } from "@lando/core/testing";

describe("provider integration test gate", () => {
  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "only runs provider-touching integration checks when explicitly enabled",
    () => {
      expect(resolveLiveProviderSocket()?.socketPath).toBeTruthy();
    },
  );
});
