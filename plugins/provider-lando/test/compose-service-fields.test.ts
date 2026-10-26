import { describe, expect, test } from "bun:test";

import { providerLandoCapabilitiesForPlatform } from "@lando/provider-lando";

describe("provider-lando Compose service field capabilities", () => {
  test("declares realized labels, configs and additive networks support", () => {
    expect(providerLandoCapabilitiesForPlatform("linux").composeServiceFields).toEqual({
      supported: ["labels", "configs", "networks"],
    });
    expect(providerLandoCapabilitiesForPlatform("linux").composeProjectFields).toEqual({
      supported: ["configs"],
    });
  });
});
