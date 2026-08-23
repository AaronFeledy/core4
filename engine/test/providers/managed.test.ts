import { describe, expect, test } from "bun:test";

import { ProviderUnavailableError, ServiceStartError } from "@lando/sdk/errors";

import {
  MANAGED_PROVIDER_ID,
  MANAGED_PROVIDER_SELECT_PLAN,
  taggedErrorRemediation,
} from "../../src/providers/managed.ts";
import { CAPABILITY_DEFAULT_PROVIDER_ID } from "../../src/providers/precedence.ts";

describe("managed provider constants", () => {
  test("MANAGED_PROVIDER_ID is the capability default lando provider", () => {
    expect(String(MANAGED_PROVIDER_ID)).toBe("lando");
    expect(MANAGED_PROVIDER_ID).toBe(CAPABILITY_DEFAULT_PROVIDER_ID);
    expect(String(MANAGED_PROVIDER_SELECT_PLAN.provider)).toBe("lando");
    expect(MANAGED_PROVIDER_SELECT_PLAN.name).toBe("global");
  });
});

describe("taggedErrorRemediation", () => {
  test("pulls remediation off a tagged error cause", () => {
    const cause = new ProviderUnavailableError({
      providerId: "docker",
      operation: "docker-api",
      message: "Docker API request failed with exit code 7.",
      remediation: "Run `lando setup --provider=lando`, then retry `lando start`.",
    });
    expect(taggedErrorRemediation(cause)).toBe(
      "Run `lando setup --provider=lando`, then retry `lando start`.",
    );
  });

  test("returns undefined when the cause has no remediation", () => {
    expect(taggedErrorRemediation(undefined)).toBeUndefined();
    expect(taggedErrorRemediation("plain")).toBeUndefined();
    expect(taggedErrorRemediation({ message: "no remediation" })).toBeUndefined();
    expect(taggedErrorRemediation({ remediation: "" })).toBeUndefined();
  });

  test("lifts leftover proxy-port remediation off a service start error", () => {
    // Given: a start failure whose remediation names leftover loopback holders
    const remediation =
      "A leftover rootlessport is holding the Traefik loopback ports. Run `lando global:stop`. If that does not release the ports, terminate the leftover rootlessport process manually before retrying. Run `lando setup` if the managed runtime is broken.";
    const cause = new ServiceStartError({
      providerId: "lando",
      operation: "start",
      service: "traefik",
      message: "address already in use 38080",
      remediation,
    });

    // When: user start copies cause.remediation
    const lifted = taggedErrorRemediation(cause);

    // Then: the leftover tokens survive the lift unchanged
    expect(lifted).toBe(remediation);
    expect(lifted).toContain("lando global:stop");
    expect(lifted).toContain("rootlessport");
    expect(lifted).toContain("lando setup");
  });
});
