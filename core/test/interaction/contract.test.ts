import { Readable } from "node:stream";

import { describe, expect, test } from "bun:test";

import { Cause, Effect, Exit, Option, Redacted } from "effect";

import type { PromptAnswer, PromptSpec } from "@lando/sdk/schema";
import type {
  ConfirmSpec,
  InteractionError,
  InteractionServiceShape,
  PromptAnswers,
  SecretSpec,
  SelectSpec,
} from "@lando/sdk/services";
import {
  type InteractionContractHarness,
  type InteractionServiceSpec,
  runInteractionContract,
} from "@lando/sdk/test";

import { makeInteractionService } from "../../src/interaction/service.ts";
import { makeTestInteractionService } from "../../src/testing/interaction.ts";

const scriptedStdin = (lines: ReadonlyArray<string>): NodeJS.ReadableStream =>
  Readable.from(lines.map((line) => `${line}\n`));

const neverStdin = (): NodeJS.ReadableStream =>
  new Readable({
    read() {
      // never push — readLine blocks until interrupted
    },
  });

const noopWritable = () => {
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;
  return sink;
};

const liveServiceFromSpec = (spec: InteractionServiceSpec): InteractionServiceShape => {
  const baseStdin = spec.neverStdin ? neverStdin() : scriptedStdin(spec.scriptedInput ?? []);
  if (spec.tty === true) Object.assign(baseStdin, { isTTY: true });
  return makeInteractionService({
    stdin: baseStdin,
    stdout: noopWritable(),
    ...(spec.choicesResult === undefined
      ? {}
      : {
          choicesRunner: async () =>
            spec.choicesResult as { exitCode: number; stdout: string; stderr: string },
        }),
  });
};

const runContract = (harness: InteractionContractHarness): Promise<Exit.Exit<void, unknown>> =>
  Effect.runPromiseExit(runInteractionContract(harness));

const liveHarness: InteractionContractHarness = {
  name: "InteractionServiceLive",
  makeService: liveServiceFromSpec,
  capabilities: {
    interactive: true,
    promptTypes: ["text", "select", "number", "secret"],
    secretRedaction: true,
  },
  supportsInteractiveInput: true,
  supportsInterruption: true,
  supportsDynamicChoices: true,
};

const testDoubleHarness: InteractionContractHarness = {
  name: "TestInteractionService",
  makeService: (spec) =>
    makeTestInteractionService({ stdin: spec.neverStdin ? undefined : undefined }).service,
  capabilities: {
    interactive: false,
    promptTypes: ["text", "select", "number", "secret"],
    secretRedaction: true,
  },
};

describe("runInteractionContract", () => {
  test("the Live InteractionService satisfies the contract", async () => {
    const exit = await runContract(liveHarness);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      throw new Error(
        `Live contract failed: ${Option.isSome(failure) ? JSON.stringify(failure.value) : Cause.pretty(exit.cause)}`,
      );
    }
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("the TestInteractionService satisfies the contract", async () => {
    const exit = await runContract(testDoubleHarness);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      throw new Error(
        `TestInteractionService contract failed: ${Option.isSome(failure) ? JSON.stringify(failure.value) : Cause.pretty(exit.cause)}`,
      );
    }
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

const failureAssertion = (exit: Exit.Exit<void, unknown>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure) ? (failure.value as { assertion?: string }).assertion : undefined;
};

const rejectedWithContractFailure = (exit: Exit.Exit<void, unknown>): boolean => {
  if (!Exit.isFailure(exit)) return false;
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure) && (failure.value as { _tag?: string })._tag === "ContractFailure";
};

describe("runInteractionContract rejects weakened implementations", () => {
  test("an implementation that resolves non-interactively instead of failing fast is rejected", async () => {
    const weakNonInteractive: InteractionContractHarness = {
      makeService: (spec) => {
        const real = liveServiceFromSpec(spec);
        return {
          ...real,
          // Only coerce a bare prompt with no supplied answer, no default, and no
          // --yes: that is exactly the fail-fast scenario the contract probes.
          promptAll: (specs, options) => {
            const supplied = options?.answers ?? {};
            const needsCoercion =
              options?.yes !== true &&
              specs.some((s) => supplied[s.name] === undefined && s.default === undefined);
            if (!needsCoercion) return real.promptAll(specs, options);
            return real.promptAll(specs, {
              ...options,
              answers: { ...Object.fromEntries(specs.map((s) => [s.name, "x"])), ...supplied },
            }) as Effect.Effect<PromptAnswers, InteractionError, never>;
          },
        } satisfies InteractionServiceShape;
      },
      capabilities: { interactive: false, promptTypes: ["text", "number", "secret"], secretRedaction: true },
    };
    const exit = await runContract(weakNonInteractive);
    expect(rejectedWithContractFailure(exit)).toBe(true);
    expect(failureAssertion(exit)).toContain("fails fast");
  });

  test("an implementation that leaks the raw secret value is rejected", async () => {
    const leakySecret: InteractionContractHarness = {
      makeService: (spec) => {
        const real = liveServiceFromSpec(spec);
        // A real Redacted whose value the contract can read, but whose JSON form
        // leaks the plaintext — weakening the secret-redaction guarantee.
        const leaked = Object.assign(Redacted.make("hunter2"), {
          toJSON: () => "hunter2",
        }) as Redacted.Redacted<string>;
        return {
          ...real,
          secret: (_spec: SecretSpec) => Effect.succeed(leaked),
        } satisfies InteractionServiceShape;
      },
      capabilities: { interactive: true, promptTypes: ["secret"], secretRedaction: true },
    };
    const exit = await runContract(leakySecret);
    expect(rejectedWithContractFailure(exit)).toBe(true);
    expect(failureAssertion(exit)).toBe("a secret value never appears in its string or JSON representation");
  });

  test("an implementation that ignores answer precedence is rejected", async () => {
    const ignoresPrecedence: InteractionContractHarness = {
      makeService: () => {
        const real = makeInteractionService({ stdin: neverStdin(), stdout: noopWritable() });
        return {
          ...real,
          promptAll: (specs: ReadonlyArray<PromptSpec>) =>
            Effect.succeed(
              Object.fromEntries(specs.map((s) => [s.name, "ignored"])) as Record<string, PromptAnswer>,
            ) as Effect.Effect<PromptAnswers, InteractionError, never>,
          confirm: (_spec: ConfirmSpec) => Effect.succeed(false),
          select: <A extends string | number | boolean>(_spec: SelectSpec<A>) =>
            Effect.succeed("ignored" as A),
        } satisfies InteractionServiceShape;
      },
      capabilities: { interactive: false, promptTypes: ["text"], secretRedaction: true },
    };
    const exit = await runContract(ignoresPrecedence);
    expect(rejectedWithContractFailure(exit)).toBe(true);
    expect(failureAssertion(exit)).toBe("an explicit answer wins over prompting and over the default");
  });
});
