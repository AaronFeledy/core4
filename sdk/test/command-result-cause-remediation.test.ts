import { describe, expect, test } from "bun:test";

import { causeRemediation } from "@lando/sdk/command-result";
import { ProviderUnavailableError } from "@lando/sdk/errors";

describe("causeRemediation", () => {
  test("pulls remediation off a tagged error cause", () => {
    const cause = new ProviderUnavailableError({
      providerId: "docker",
      operation: "docker-api",
      message: "Docker API request failed with exit code 7.",
      remediation: "Run `lando setup --provider=lando`, then retry `lando start`.",
    });
    expect(causeRemediation(cause)).toBe("Run `lando setup --provider=lando`, then retry `lando start`.");
  });

  test("returns undefined when the cause has no remediation", () => {
    expect(causeRemediation(undefined)).toBeUndefined();
    expect(causeRemediation("plain")).toBeUndefined();
    expect(causeRemediation({ message: "no remediation" })).toBeUndefined();
    expect(causeRemediation({ remediation: "" })).toBeUndefined();
  });
});
