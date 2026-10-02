import { describe, expect, test } from "bun:test";
import { InteractionService } from "@lando/sdk/services";
import { Effect } from "effect";
import { requireConfirmation } from "../../src/cli/require-confirmation";
import { makeTestInteractionService } from "../../src/testing/interaction";

describe("requireConfirmation", () => {
  test.each([
    { yes: true, interactive: false, answer: "false", proceeds: true, prompts: 0 },
    { yes: true, interactive: true, answer: "false", proceeds: true, prompts: 0 },
    { yes: false, interactive: true, answer: "true", proceeds: true, prompts: 1 },
    { yes: false, interactive: true, answer: "false", proceeds: false, prompts: 1 },
    { yes: false, interactive: false, answer: "true", proceeds: false, prompts: 0 },
    { yes: false, interactive: true, answer: "invalid", proceeds: false, prompts: 1 },
  ])("gates mutation for %j", async ({ yes, interactive, answer, proceeds, prompts }) => {
    // Given
    const interaction = makeTestInteractionService({ answers: { confirm: answer } });
    let mutations = 0;
    // When
    const result = await Effect.runPromise(
      Effect.scoped(
        requireConfirmation({ yes, message: "Confirm?" }).pipe(
          Effect.andThen(
            Effect.sync(() => {
              mutations += 1;
            }),
          ),
          Effect.provideService(InteractionService, {
            ...interaction.service,
            isInteractive: Effect.succeed(interactive),
          }),
          Effect.result,
        ),
      ),
    );
    // Then
    expect(mutations).toBe(proceeds ? 1 : 0);
    expect(interaction.transcript()).toHaveLength(prompts);
    if (!proceeds) {
      expect(result).toMatchObject({
        _tag: "Left",
        left: {
          _tag: "CommandConfirmationError",
          reason: interactive ? "declined" : "non-interactive",
          remediation: expect.stringContaining("--yes"),
        },
      });
    } else {
      expect(result._tag).toBe("Success");
    }
  });

  test("fails non-interactively when InteractionService is absent", async () => {
    // Given / When
    const error = await Effect.runPromise(
      Effect.scoped(requireConfirmation({ yes: false, message: "Confirm?" }).pipe(Effect.flip)),
    );
    // Then
    expect(error.reason).toBe("non-interactive");
  });

  test("skips even interaction discovery when yes is supplied", async () => {
    // Given / When
    const result = await Effect.runPromise(
      Effect.scoped(requireConfirmation({ yes: true, message: "Confirm?" })),
    );
    // Then
    expect(result).toBeUndefined();
  });
});
