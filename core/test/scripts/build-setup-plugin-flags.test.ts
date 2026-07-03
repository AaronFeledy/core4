import { describe, expect, test } from "bun:test";

import { contributionId } from "../../../scripts/build-setup-plugin-flags.ts";

describe("build-setup-plugin-flags contributionId", () => {
  test("passes through a plain provider id string", () => {
    expect(contributionId("docker")).toBe("docker");
  });

  test("extracts the id from a deprecated ContributionRef object", () => {
    expect(
      contributionId({
        id: "legacy-docker",
        deprecated: { since: "4.0.0", note: "renamed", removeIn: "5.0.0" },
      }),
    ).toBe("legacy-docker");
  });
});
