import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { makeSetupHostChangeConsent } from "../../src/cli/oclif/commands/meta/setup-host-change-consent.ts";
import { makeTestInteractionService } from "../../src/testing/interaction.ts";

const packageInstallRequest = {
  _tag: "package-install",
  packageName: "uidmap",
  reason: "Rootless Podman requires newuidmap and newgidmap.",
} as const;

const lingerRequest = {
  _tag: "enable-user-linger",
  uid: 1000,
  reason: "Keep the rootless provider available after logout.",
} as const;

describe("setup host-change consent", () => {
  test.each([
    ["package-install with --yes", packageInstallRequest, true, false, true],
    ["package-install with --no-interactive", packageInstallRequest, false, true, false],
    ["package-install with --yes --no-interactive", packageInstallRequest, true, true, true],
    ["enable-user-linger with --yes", lingerRequest, true, false, true],
    ["enable-user-linger with --no-interactive", lingerRequest, false, true, false],
    ["enable-user-linger with --yes --no-interactive", lingerRequest, true, true, true],
  ] as const)("maps %s without prompting", async (_label, request, yes, nonInteractive, expected) => {
    // Given: automation flags fully determine consent.
    const interaction = makeTestInteractionService();
    const consent = makeSetupHostChangeConsent({ yes, nonInteractive, interaction: interaction.service });

    // When: a provider requests the fixed host change.
    const result = await Effect.runPromise(consent(request));

    // Then: the decision is deterministic and stdin remains untouched.
    expect(result).toBe(expected);
    expect(interaction.transcript()).toEqual([]);
  });

  test("interactive consent prompts once with the exact package and reason", async () => {
    // Given: interactive setup has a seeded affirmative answer.
    const interaction = makeTestInteractionService({ answers: { "provider-host-change": "true" } });
    const consent = makeSetupHostChangeConsent({
      yes: false,
      nonInteractive: false,
      interaction: interaction.service,
    });

    // When: the provider requests uidmap consent.
    const result = await Effect.runPromise(consent(packageInstallRequest));

    // Then: the interaction abstraction records one explanatory confirmation.
    expect(result).toBe(true);
    expect(interaction.transcript()).toEqual([
      {
        name: "provider-host-change",
        type: "confirm",
        message: 'Install host package "uidmap"? Rootless Podman requires newuidmap and newgidmap.',
      },
    ]);
  });

  test("interactive linger consent explains the optional UID action and defaults to false", async () => {
    // Given: interactive setup has no pre-seeded consent for optional persistence.
    const interaction = makeTestInteractionService();
    const consent = makeSetupHostChangeConsent({
      yes: false,
      nonInteractive: false,
      interaction: interaction.service,
    });

    // When: the provider requests linger for the current user.
    const result = await Effect.runPromise(consent(lingerRequest));

    // Then: the optional action is refused by default after one explanatory prompt.
    expect(result).toBe(false);
    expect(interaction.transcript()).toEqual([
      {
        name: "provider-host-change",
        type: "confirm",
        message:
          "Enable user linger for UID 1000 as an optional persistence convenience? Keep the rootless provider available after logout.",
      },
    ]);
  });
});
