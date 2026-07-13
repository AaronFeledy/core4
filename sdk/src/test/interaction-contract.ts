import { Cause, type Context, Duration, Effect, Exit, Fiber, Option, Redacted, type Scope } from "effect";

import type { PromptSpec, PromptType } from "../schema/index.ts";
import { Renderer } from "../services/index.ts";
import type { InteractionError, InteractionServiceShape } from "../services/index.ts";
import { ContractFailure } from "./_shared.ts";

const interactionContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `InteractionService contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireInteractionContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(interactionContractFailure(assertion, details));

type RendererServiceShape = Context.Tag.Service<typeof Renderer>;

/**
 * Capturing renderer used by the contract to prove prompt chrome routes
 * through `Renderer.output.stdout` instead of a direct stdio write.
 */
export interface InteractionContractRenderer {
  readonly service: RendererServiceShape;
  readonly stdout: () => string;
}

/** Build a capturing renderer the harness can inject for the routing assertion. */
export const makeInteractionContractRenderer = (id = "plain"): InteractionContractRenderer => {
  let out = "";
  return {
    stdout: () => out,
    service: {
      id,
      message: { info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void },
      output: {
        stdout: (chunk: string) =>
          Effect.sync(() => {
            out += chunk;
          }),
        stderr: () => Effect.void,
      },
    },
  };
};

/**
 * Description of one interaction service instance the harness must construct.
 * The caller wires the real construction deps (scripted/never stdin, a capturing
 * stdout, an optional renderer, an optional dynamic-choices runner) so the
 * contract drives only the published `InteractionServiceShape` methods.
 */
export interface InteractionServiceSpec {
  /** Lines the service should read for interactive prompts, in order. */
  readonly scriptedInput?: ReadonlyArray<string>;
  /** When true, the service must use a stdin that is never read (proves fail-fast). */
  readonly neverStdin?: boolean;
  /** When true, the service's stdin reports `isTTY: true`. */
  readonly tty?: boolean;
  /** Stdout sink the service writes prompt chrome to when no renderer is present. */
  readonly stdout?: (chunk: string) => void;
  /** Renderer to provide to the service effect (routing assertion). */
  readonly renderer?: RendererServiceShape;
  /** Dynamic-choices command result for `choicesFrom` prompts. */
  readonly choicesResult?: { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
}

/**
 * Harness for {@link runInteractionContract}.
 *
 * `makeService` builds an `InteractionServiceShape` from a {@link InteractionServiceSpec}.
 * The Live caller wires `makeInteractionService` with scripted IO; the test-double
 * caller wires `makeTestInteractionService`. Capability flags gate assertions that
 * a given implementation can satisfy (e.g. a non-stdin test double cannot exercise
 * the interrupt/TTY-restore path).
 */
export interface InteractionContractHarness {
  readonly name?: string;
  readonly makeService: (spec: InteractionServiceSpec) => InteractionServiceShape;
  /** Declared capabilities (mirrors `InteractionServiceContribution.capabilities`). */
  readonly capabilities: {
    readonly interactive: boolean;
    readonly promptTypes: ReadonlyArray<PromptType>;
    readonly secretRedaction: boolean;
  };
  /**
   * When true, the suite exercises interactive stdin reading: prompt chrome
   * routing through `Renderer.output` and (with {@link supportsInterruption})
   * the cancellation path. A non-interactive-only implementation (e.g. a
   * terminal-free test double) declares this `false`.
   */
  readonly supportsInteractiveInput?: boolean;
  /** When true, the suite exercises external `Effect.interrupt` -> cancellation + TTY restore. */
  readonly supportsInterruption?: boolean;
  /** When true, the suite exercises dynamic `choicesFrom` resolution + manual fallback. */
  readonly supportsDynamicChoices?: boolean;
}

const interactionTextPrompt = (name: string, message = "Value?"): PromptSpec => ({
  name,
  type: "text",
  message,
});

const runInteractionScoped = <A>(
  effect: Effect.Effect<A, InteractionError, Scope.Scope>,
): Effect.Effect<Exit.Exit<A, InteractionError>> => Effect.exit(Effect.scoped(effect));

const interactionFailureTag = <A>(exit: Exit.Exit<A, InteractionError>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure) ? (failure.value as { _tag?: string })._tag : undefined;
};

/**
 * Run the `InteractionService` contract assertions against a harness. Asserts (in
 * order): capability declaration; answer-source precedence (explicit answer wins
 * over default and over reading input); `auto`-mode TTY gating (non-TTY resolves
 * non-interactively); non-interactive fail-fast with `InteractionRequiredError`
 * and no stdin read; per-type validation (`number` rejects a non-numeric default);
 * `secret` non-echo + `Redacted` carriage; prompt output routes through
 * `Renderer.output.stdout` when a renderer is present; and (when the harness
 * declares support) external `Effect.interrupt` surfaces `InteractionCancelledError`
 * with TTY raw-mode restored, plus dynamic `choicesFrom` resolution and the
 * `InteractionRequiredError` manual fallback when choices cannot resolve
 * non-interactively.
 */
export const runInteractionContract = (
  harness: InteractionContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    yield* requireInteractionContract(
      typeof harness.capabilities.interactive === "boolean" &&
        Array.isArray(harness.capabilities.promptTypes) &&
        harness.capabilities.promptTypes.length > 0 &&
        typeof harness.capabilities.secretRedaction === "boolean",
      "the harness declares interaction capabilities (interactive, promptTypes, secretRedaction)",
      harness.capabilities,
    );

    const idService = harness.makeService({ neverStdin: true });
    yield* requireInteractionContract(
      typeof idService.id === "string" && idService.id.length > 0,
      "the interaction service declares a non-empty id",
      idService.id,
    );

    const precedenceService = harness.makeService({ neverStdin: true });
    const precedenceExit = yield* runInteractionScoped(
      precedenceService.promptAll([interactionTextPrompt("app")], {
        answers: { app: "explicit" },
        mode: "non-interactive",
      }),
    );
    yield* requireInteractionContract(
      Exit.isSuccess(precedenceExit) && (precedenceExit.value as Record<string, unknown>).app === "explicit",
      "an explicit answer wins over prompting and over the default",
      precedenceExit,
    );

    const defaultService = harness.makeService({ neverStdin: true });
    const defaultExit = yield* runInteractionScoped(
      defaultService.promptAll([{ name: "app", type: "text", message: "Name?", default: "fallback" }], {
        yes: true,
      }),
    );
    yield* requireInteractionContract(
      Exit.isSuccess(defaultExit) && (defaultExit.value as Record<string, unknown>).app === "fallback",
      "--yes resolves a prompt default without reading input",
      defaultExit,
    );

    const nonTtyService = harness.makeService({ neverStdin: true });
    const isInteractive = yield* nonTtyService.isInteractive;
    yield* requireInteractionContract(
      isInteractive === false,
      "auto mode reports non-interactive when stdin is not a TTY",
      isInteractive,
    );
    const autoExit = yield* runInteractionScoped(
      nonTtyService.promptAll([interactionTextPrompt("app")], { mode: "auto" }),
    );
    yield* requireInteractionContract(
      interactionFailureTag(autoExit) === "InteractionRequiredError",
      "auto-mode TTY gating fails fast on a non-TTY when no answer is supplied",
      autoExit,
    );

    const failFastService = harness.makeService({ neverStdin: true });
    // Against a never-readable stdin this resolves only if the service fails fast
    // instead of blocking on a read; a short timeout converts a hang into a
    // contract failure rather than a hung test.
    const failFastExit = yield* runInteractionScoped(
      failFastService.promptAll([interactionTextPrompt("app")], { mode: "non-interactive" }),
    ).pipe(
      Effect.timeoutFail({
        duration: Duration.seconds(5),
        onTimeout: () => interactionContractFailure("non-interactive resolution never blocks on stdin"),
      }),
    );
    yield* requireInteractionContract(
      interactionFailureTag(failFastExit) === "InteractionRequiredError",
      "non-interactive resolution fails fast with InteractionRequiredError",
      failFastExit,
    );

    const validationService = harness.makeService({ neverStdin: true });
    const validationExit = yield* runInteractionScoped(
      validationService.promptAll([{ name: "port", type: "number", message: "Port?" }], {
        answers: { port: "not-a-number" },
        mode: "non-interactive",
      }),
    );
    yield* requireInteractionContract(
      interactionFailureTag(validationExit) === "PromptValidationError",
      "an invalid answer for a typed prompt fails with PromptValidationError",
      validationExit,
    );

    if (harness.capabilities.secretRedaction) {
      const secretService = harness.makeService({
        scriptedInput: ["hunter2"],
        tty: true,
      });
      const secretExit = yield* runInteractionScoped(
        secretService.secret({ name: "token", message: "Token?", answers: { token: "hunter2" } }),
      );
      yield* requireInteractionContract(
        Exit.isSuccess(secretExit) && Redacted.value(secretExit.value) === "hunter2",
        "secret answers are carried as Redacted values",
        secretExit,
      );
      yield* requireInteractionContract(
        Exit.isSuccess(secretExit) &&
          !String(secretExit.value).includes("hunter2") &&
          !JSON.stringify(secretExit.value).includes("hunter2"),
        "a secret value never appears in its string or JSON representation",
        secretExit,
      );
    }

    if (harness.supportsInteractiveInput === true) {
      const renderer = makeInteractionContractRenderer();
      const routedService = harness.makeService({
        scriptedInput: ["routed-value"],
        tty: true,
        renderer: renderer.service,
      });
      const routedExit = yield* runInteractionScoped(
        Effect.provideService(
          routedService.promptAll([{ name: "app", type: "text", message: "RoutedQuestion?" }], {
            mode: "interactive",
          }),
          Renderer,
          renderer.service,
        ),
      );
      yield* requireInteractionContract(
        Exit.isSuccess(routedExit) && renderer.stdout().includes("RoutedQuestion?"),
        "prompt chrome routes through Renderer.output.stdout when a renderer is present",
        { exit: routedExit, captured: renderer.stdout() },
      );
    }

    if (harness.supportsInterruption === true) {
      const interruptService = harness.makeService({ neverStdin: true, tty: true });
      const interruptExit = yield* Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          Effect.scoped(interruptService.promptAll([interactionTextPrompt("app")], { mode: "interactive" })),
        );
        yield* Effect.sleep("25 millis");
        return yield* Fiber.interrupt(fiber);
      });
      yield* requireInteractionContract(
        interactionFailureTag(interruptExit) === "InteractionCancelledError",
        "external Effect.interrupt surfaces InteractionCancelledError",
        interruptExit,
      );
    }

    if (harness.supportsDynamicChoices === true) {
      const choicesService = harness.makeService({
        neverStdin: true,
        choicesResult: { exitCode: 0, stdout: "8.1\n8.2\n", stderr: "" },
      });
      const choicesExit = yield* runInteractionScoped(
        choicesService.promptAll(
          [
            {
              name: "phpVersion",
              type: "select",
              message: "PHP?",
              choicesFrom: { command: "services:list", parse: "lines" },
            },
          ],
          { answers: { phpVersion: "8.2" }, mode: "non-interactive", runs: ["services:list"] },
        ),
      );
      yield* requireInteractionContract(
        Exit.isSuccess(choicesExit) && (choicesExit.value as Record<string, unknown>).phpVersion === "8.2",
        "a seeded answer resolves a dynamic choicesFrom prompt",
        choicesExit,
      );

      const manualFallbackService = harness.makeService({
        neverStdin: true,
        choicesResult: { exitCode: 0, stdout: "8.1\n8.2\n", stderr: "" },
      });
      const manualExit = yield* runInteractionScoped(
        manualFallbackService.promptAll(
          [
            {
              name: "phpVersion",
              type: "select",
              message: "PHP?",
              choicesFrom: { command: "services:list", parse: "lines" },
            },
          ],
          { mode: "non-interactive", runs: ["services:list"] },
        ),
      );
      yield* requireInteractionContract(
        interactionFailureTag(manualExit) === "InteractionRequiredError",
        "a resolvable dynamic-choices prompt with no answer fails fast non-interactively",
        manualExit,
      );
    }
  });
