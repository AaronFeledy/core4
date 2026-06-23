// In-memory `InteractionService` test double. It reuses the real prompt engine
// (`makeInteractionService`) bound to a fail-on-read stdin and a non-interactive
// default mode, so seeded answers exercise the same coercion, validation, and
// answer-source precedence the Live service applies — while never opening a real
// terminal. Requested prompts are captured in a transcript for assertions.

import { Layer as EffectLayer, type Layer } from "effect";

import type { PromptBatchOptions, PromptSpec, PromptType } from "@lando/sdk/schema";
import {
  type ConfirmSpec,
  InteractionService,
  type InteractionServiceShape,
  type SecretSpec,
  type SelectSpec,
} from "@lando/sdk/services";

import { makeInteractionService } from "../interaction/service.ts";

const TEST_INTERACTION_ID = "test-stdio";

/** A single prompt the test double was asked to resolve. */
export interface TestPromptRecord {
  readonly name: string;
  readonly type: PromptType;
  readonly message: string;
}

/** Handle returned by {@link makeTestInteractionService}. */
export interface TestInteractionService {
  /** The `InteractionService` implementation backed by seeded answers. */
  readonly service: InteractionServiceShape;
  /** A `Layer` providing the test service for runtime composition. */
  readonly layer: Layer.Layer<InteractionService>;
  /** Snapshot of the prompts requested, in request order. */
  readonly transcript: () => ReadonlyArray<TestPromptRecord>;
}

/** Construction inputs for {@link makeTestInteractionService}. */
export interface TestInteractionServiceOptions {
  /** Answers pre-seeded by prompt name; merged below any per-batch answers. */
  readonly answers?: Readonly<Record<string, string>>;
  /** Optional stdin override; defaults to a stream that throws if read. */
  readonly stdin?: NodeJS.ReadableStream;
  /** Service id; defaults to `test-stdio`. */
  readonly id?: string;
}

const neverReadStdin = (): NodeJS.ReadableStream =>
  ({
    [Symbol.asyncIterator]() {
      return {
        next() {
          return Promise.reject(new Error("TestInteractionService must not read stdin"));
        },
      };
    },
  }) as unknown as NodeJS.ReadableStream;

const recordPrompt = (records: TestPromptRecord[], spec: PromptSpec): void => {
  records.push({ name: spec.name, type: spec.type, message: spec.message });
};

const mergeAnswers = (
  seeded: Readonly<Record<string, string>>,
  options: PromptBatchOptions | undefined,
): PromptBatchOptions => ({ ...options, answers: { ...seeded, ...(options?.answers ?? {}) } });

/** Build an in-memory `InteractionService` for tests with seeded answers. */
export const makeTestInteractionService = (
  options: TestInteractionServiceOptions = {},
): TestInteractionService => {
  const seeded = options.answers ?? {};
  const records: TestPromptRecord[] = [];
  const engine = makeInteractionService({
    stdin: options.stdin ?? neverReadStdin(),
    defaultMode: "non-interactive",
    id: options.id ?? TEST_INTERACTION_ID,
  });

  const promptAllSpecs = (specs: ReadonlyArray<PromptSpec>, options?: PromptBatchOptions) => {
    for (const spec of specs) recordPrompt(records, spec);
    return engine.promptAll(specs, mergeAnswers(seeded, options));
  };

  const service: InteractionServiceShape = {
    id: engine.id,
    isInteractive: engine.isInteractive,
    prompt: (spec) => {
      recordPrompt(records, spec);
      return engine.prompt(spec);
    },
    promptAll: (specs, options) => promptAllSpecs(specs, options),
    confirm: (spec: ConfirmSpec) => {
      records.push({ name: spec.name ?? "confirm", type: "confirm", message: spec.message });
      return engine.confirm(mergeAnswers(seeded, spec) as ConfirmSpec);
    },
    select: <A extends string | number | boolean>(spec: SelectSpec<A>) => {
      records.push({ name: spec.name ?? "select", type: "select", message: spec.message });
      return engine.select(mergeAnswers(seeded, spec) as SelectSpec<A>);
    },
    secret: (spec: SecretSpec) => {
      records.push({ name: spec.name ?? "secret", type: "secret", message: spec.message });
      return engine.secret(mergeAnswers(seeded, spec) as SecretSpec);
    },
  };

  return {
    service,
    layer: EffectLayer.succeed(InteractionService, service),
    transcript: () => records,
  } satisfies TestInteractionService;
};
