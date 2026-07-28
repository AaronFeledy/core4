import { describe, expect, test } from "bun:test";

import { dockerCapabilitiesForPlatform } from "@lando/provider-docker";

describe("provider-docker Compose service field capabilities", () => {
  test("omits the fail-closed declaration", () => {
    expect(dockerCapabilitiesForPlatform("linux").composeServiceFields).toBeUndefined();
  });
});
