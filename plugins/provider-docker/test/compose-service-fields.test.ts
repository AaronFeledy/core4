import { describe, expect, test } from "bun:test";

import { dockerCapabilitiesForPlatform } from "@lando/provider-docker";

describe("provider-docker Compose service field capabilities", () => {
  test("declares only realized user-label support at the native tier", () => {
    const capabilities = dockerCapabilitiesForPlatform("linux");

    expect(capabilities.composeSpec).toBe("native");
    expect(capabilities.composeServiceFields).toEqual({ supported: ["labels", "configs"] });
    expect(capabilities.composeProjectFields).toEqual({ supported: ["configs"] });
  });
});
