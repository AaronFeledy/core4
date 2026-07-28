import { describe, expect, test } from "bun:test";

import { providerLandoCapabilitiesForPlatform } from "@lando/provider-lando";

describe("provider-lando Compose service field capabilities", () => {
  test("declares only inert extension field support", () => {
    expect(providerLandoCapabilitiesForPlatform("linux").composeServiceFields).toEqual({
      supported: ["x-*"],
    });
  });
});
