import { describe, expect, test } from "bun:test";

import { ProviderUnavailableError, ServiceStartError } from "@lando/sdk/errors";

import { taggedErrorRemediation } from "../../src/providers/managed.ts";

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
    // Given
    const remediation =
      "A leftover rootlessport is holding the Traefik loopback ports. Run `lando global:stop`. If that does not release the ports, terminate the leftover rootlessport process manually before retrying. Run `lando setup` if the managed runtime is broken.";
    const cause = new ServiceStartError({
      providerId: "lando",
      operation: "start",
      service: "traefik",
      message: "address already in use 38080",
      remediation,
    });

    // When
    const lifted = taggedErrorRemediation(cause);

    // Then
    expect(lifted).toBe(remediation);
    expect(lifted).toContain("lando global:stop");
    expect(lifted).toContain("rootlessport");
    expect(lifted).toContain("lando setup");
  });
});
