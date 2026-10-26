import { describe, expect, test } from "bun:test";

import { dockerCapabilitiesForPlatform } from "@lando/provider-docker";

describe("provider-docker Compose service field capabilities", () => {
  test("declares realized labels, configs and additive networks at the native tier", () => {
    const capabilities = dockerCapabilitiesForPlatform("linux");

    expect(capabilities.composeSpec).toBe("native");
    expect(capabilities.composeServiceFields).toEqual({ supported: ["labels", "configs", "networks"] });
    expect(capabilities.composeProjectFields).toEqual({ supported: ["configs"] });
  });
});
