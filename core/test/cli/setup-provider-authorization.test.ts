import { describe, expect, test } from "bun:test";
import { ProviderId, type ProviderSetupPlan } from "@lando/sdk/schema";
import type { InteractionServiceShape } from "@lando/sdk/services";
import { Cause, Effect } from "effect";
import { authorizeProviderSetupPlan } from "../../src/cli/command-specs/meta/setup-provider-authorization.ts";

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
    expect(approved.plan).toBe(plan);
    expect(calls).toEqual(["provider-setup-consent"]);
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
    const failure = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
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
    expect(approved.plan).toBe(plan);
    expect(calls).toEqual([]);
  });

  const linger = (optedIn: boolean): ProviderSetupPlan => ({
    providerId: ProviderId.make("lando"),
    changes: [
      ...plan.changes,
      { _tag: "enable-user-linger", user: "dev", uid: 1001, optedIn, reason: "No user manager runs." },
    ],
  });

  test.each([
    [false, false],
    [true, true],
  ])(
    "an unattended denial names --enable-linger only when lingering is planned (%p)",
    async (lingerPlanned, named) => {
      // When
      const exit = await Effect.runPromiseExit(
        authorizeProviderSetupPlan(lingerPlanned ? linger(false) : plan, {
          yes: false,
          nonInteractive: true,
          interaction: undefined,
        }),
      );

      // Then
      const failure = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
      const remediation = failure?._tag === "Some" ? failure.value.remediation : "";
      expect(remediation).toContain("--yes");
      expect(remediation.includes("--enable-linger")).toBe(named);
    },
  );

  test("--yes approves standard changes but skips lingering without its own opt-in", async () => {
    // Given
    const calls: string[] = [];

    // When
    const approved = await Effect.runPromise(
      authorizeProviderSetupPlan(linger(false), {
        yes: true,
        nonInteractive: false,
        interaction: interaction(true, calls),
      }),
    );

    // Then
    expect(approved.plan.changes.map((change) => change._tag)).toEqual(["install-uidmap"]);
    expect(approved.skipped.map((change) => change._tag)).toEqual(["enable-user-linger"]);
    expect(calls).toEqual([]);
  });

  test("the provider's opt-in flag approves lingering in an unattended run", async () => {
    // When
    const approved = await Effect.runPromise(
      authorizeProviderSetupPlan(linger(true), { yes: true, nonInteractive: true, interaction: undefined }),
    );

    // Then
    expect(approved.plan.changes.map((change) => change._tag)).toEqual([
      "install-uidmap",
      "enable-user-linger",
    ]);
    expect(approved.skipped).toEqual([]);
  });

  test("an interactive run asks about lingering separately and skips it when declined", async () => {
    // Given
    const calls: string[] = [];
    const answers = (spec: { readonly name?: string }) => spec.name !== "provider-setup-linger-consent";
    const asking: InteractionServiceShape = {
      ...interaction(true, calls),
      confirm: (spec) =>
        Effect.sync(() => {
          calls.push(spec.name ?? "");
          return answers(spec);
        }),
    };

    // When
    const approved = await Effect.runPromise(
      authorizeProviderSetupPlan(linger(false), { yes: false, nonInteractive: false, interaction: asking }),
    );

    // Then
    expect(calls).toEqual(["provider-setup-consent", "provider-setup-linger-consent"]);
    expect(approved.plan.changes.map((change) => change._tag)).toEqual(["install-uidmap"]);
    expect(approved.skipped.map((change) => change._tag)).toEqual(["enable-user-linger"]);
  });
});
