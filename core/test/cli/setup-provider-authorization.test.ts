import { describe, expect, test } from "bun:test";
import { Cause, Effect } from "effect";

import { ProviderId, type ProviderSetupPlan } from "@lando/sdk/schema";
import type { InteractionServiceShape } from "@lando/sdk/services";
import { authorizeProviderSetupPlan } from "../../src/cli/oclif/commands/meta/setup-provider-authorization.ts";

const plan: ProviderSetupPlan = {
  providerId: ProviderId.make("lando"),
  changes: [
    {
      _tag: "install-uidmap",
      platform: "linux",
      distribution: "ubuntu",
      version: "26.04",
      reason: "Rootless Podman needs uidmap helpers.",
    },
  ],
};

const interaction = (answer: boolean, calls: string[]): InteractionServiceShape => ({
  id: "test",
  isInteractive: Effect.succeed(true),
  prompt: () => Effect.die("unused"),
  promptAll: () => Effect.die("unused"),
  confirm: (spec) =>
    Effect.sync(() => {
      calls.push(spec.name ?? "");
      return answer;
    }),
  select: () => Effect.die("unused"),
  secret: () => Effect.die("unused"),
});

describe("provider setup authorization", () => {
  test("returns the plan after interactive consent", async () => {
    // Given
    const calls: string[] = [];

    // When
    const approved = await Effect.runPromise(
      authorizeProviderSetupPlan(plan, {
        yes: false,
        nonInteractive: false,
        interaction: interaction(true, calls),
      }),
    );

    // Then
    expect(approved).toBe(plan);
    expect(calls).toEqual(["provider-setup-install-uidmap"]);
  });

  test("returns a tagged denial without prompting in unattended mode", async () => {
    // Given
    const calls: string[] = [];

    // When
    const exit = await Effect.runPromiseExit(
      authorizeProviderSetupPlan(plan, {
        yes: false,
        nonInteractive: true,
        interaction: interaction(true, calls),
      }),
    );

    // Then
    expect(calls).toEqual([]);
    const failure = exit._tag === "Failure" ? Cause.failureOption(exit.cause) : undefined;
    expect(failure?._tag === "Some" ? failure.value._tag : undefined).toBe("ProviderSetupConsentDeniedError");
  });

  test("grants deterministic unattended consent with --yes", async () => {
    // Given
    const calls: string[] = [];

    // When
    const approved = await Effect.runPromise(
      authorizeProviderSetupPlan(plan, {
        yes: true,
        nonInteractive: true,
        interaction: interaction(false, calls),
      }),
    );

    // Then
    expect(approved).toBe(plan);
    expect(calls).toEqual([]);
  });
});
