import { describe, expect, test } from "bun:test";

import { providerLandoCapabilitiesForPlatform } from "@lando/provider-lando";

describe("provider-lando Compose service field capabilities", () => {
  test("declares realized labels and configs support", () => {
    expect(providerLandoCapabilitiesForPlatform("linux").composeServiceFields).toEqual({
      supported: ["labels", "configs"],
    });
    expect(providerLandoCapabilitiesForPlatform("linux").composeProjectFields).toEqual({
      supported: ["configs"],
    });
  });
});
