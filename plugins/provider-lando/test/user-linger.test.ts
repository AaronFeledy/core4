import { describe, expect, test } from "bun:test";

import { Effect, Exit } from "effect";

import type { ProviderHostChangeRequest } from "@lando/sdk/services";
import { UserLingerError, configureUserLinger } from "../src/user-linger.ts";

const UID = 1000;

describe("provider-lando user lingering", () => {
  test("default setup does not request consent or execute loginctl", async () => {
    // Given: setup did not explicitly select the provider's linger flag.
    const requests: ProviderHostChangeRequest[] = [];
    const commands: ReadonlyArray<string>[] = [];

    // When: the optional host convenience is evaluated.
    await Effect.runPromise(
      configureUserLinger({
        uid: UID,
        setupFlags: {},
        consent: (request) => Effect.sync(() => requests.push(request)).pipe(Effect.as(true)),
        privilege: {
          elevate: (argv) =>
            Effect.sync(() => {
              commands.push([...argv]);
              return { exitCode: 0, stdout: "", stderr: "" };
            }),
        },
      }),
    );

    // Then: default setup remains successful without host-policy interaction.
    expect(requests).toEqual([]);
    expect(commands).toEqual([]);
  });

  test("explicit opt-in with consent executes fixed loginctl argv exactly once", async () => {
    // Given: the user selected lingering and consents to the tagged host change.
    const requests: ProviderHostChangeRequest[] = [];
    const commands: ReadonlyArray<string>[] = [];

    // When: the provider applies the optional persistence convenience.
    await Effect.runPromise(
      configureUserLinger({
        uid: UID,
        setupFlags: { "enable-linger": true },
        consent: (request) =>
          Effect.sync(() => {
            requests.push(request);
            return true;
          }),
        privilege: {
          elevate: (argv) =>
            Effect.sync(() => {
              commands.push([...argv]);
              return { exitCode: 0, stdout: "", stderr: "" };
            }),
        },
      }),
    );

    // Then: one schema-derived request authorizes one fixed privilege command.
    expect(requests).toEqual([
      {
        _tag: "enable-user-linger",
        uid: UID,
        reason: "Keep the Lando-managed rootless runtime available after logout.",
      },
    ]);
    expect(commands).toEqual([["/usr/bin/loginctl", "enable-linger", String(UID)]]);
  });

  test("explicit opt-in with denial executes nothing and remains successful", async () => {
    // Given: the user selected lingering but denies the host change.
    const commands: ReadonlyArray<string>[] = [];

    // When: provider setup receives the denial.
    await Effect.runPromise(
      configureUserLinger({
        uid: UID,
        setupFlags: { "enable-linger": true },
        consent: () => Effect.succeed(false),
        privilege: {
          elevate: (argv) =>
            Effect.sync(() => {
              commands.push([...argv]);
              return { exitCode: 0, stdout: "", stderr: "" };
            }),
        },
      }),
    );

    // Then: denial is a successful no-op.
    expect(commands).toEqual([]);
  });

  test("non-interactive opt-in without yes denies without affecting setup correctness", async () => {
    // Given: core's non-interactive consent policy supplies a denial and no privilege service.
    let requestCount = 0;

    // When: the provider evaluates the explicitly selected convenience.
    await Effect.runPromise(
      configureUserLinger({
        uid: UID,
        setupFlags: { "enable-linger": true },
        consent: () =>
          Effect.sync(() => {
            requestCount += 1;
            return false;
          }),
        privilege: undefined,
      }),
    );

    // Then: consent is requested once, denial succeeds, and privilege is not required.
    expect(requestCount).toBe(1);
  });

  test("explicit consent returns a typed provider failure when loginctl cannot execute", async () => {
    // Given: the user approved lingering but loginctl reports a host-policy failure.
    // When: the fixed privilege command executes unsuccessfully.
    const exit = await Effect.runPromiseExit(
      configureUserLinger({
        uid: UID,
        setupFlags: { "enable-linger": true },
        consent: () => Effect.succeed(true),
        privilege: {
          elevate: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "access denied" }),
        },
      }),
    );

    // Then: the explicitly requested action fails with a tagged provider error.
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(UserLingerError);
      expect(exit.cause.error._tag).toBe("ProviderUnavailableError");
      expect(exit.cause.error.message).toContain("access denied");
    }
  });
});
