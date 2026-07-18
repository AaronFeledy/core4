import { Effect, Exit, Option, Scope } from "effect";

import type { TaskTreeInteractionModel } from "./task-tree-tail.ts";
import type {
  TranscriptTailPageDirection,
  TranscriptTailReaderShape,
  TranscriptTailSession,
} from "./transcript-tail-reader.ts";

interface ActiveTranscriptTail {
  readonly generation: number;
  readonly taskId: string;
  readonly scope: Scope.CloseableScope;
  readonly session: TranscriptTailSession;
}

interface TranscriptTailControllerInput {
  readonly reader: TranscriptTailReaderShape;
  readonly viewModel: TaskTreeInteractionModel;
  readonly renderFooter: () => void;
  readonly serialize: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
}

export const makeTranscriptTailController = (input: TranscriptTailControllerInput) =>
  Effect.gen(function* () {
    let generation = 0;
    let active: ActiveTranscriptTail | undefined;

    const close = Effect.suspend(() => {
      generation += 1;
      const closing = active;
      active = undefined;
      return closing === undefined ? Effect.void : Scope.close(closing.scope, Exit.succeed(undefined));
    });

    const load = (expectedGeneration: number, direction: TranscriptTailPageDirection) =>
      Effect.gen(function* () {
        const current = active;
        if (current === undefined || current.generation !== expectedGeneration) return false;
        const page = yield* current.session
          .read(direction, input.viewModel.expandedLineBudget())
          .pipe(Effect.option);
        const latest = active;
        if (
          Option.isNone(page) ||
          latest === undefined ||
          latest.generation !== expectedGeneration ||
          input.viewModel.expandedTaskId !== latest.taskId
        )
          return false;
        const updated = input.viewModel.setExpandedTranscript(latest.taskId, page.value.lines);
        if (updated) input.renderFooter();
        return updated;
      });

    const open = (taskId: string) =>
      Effect.gen(function* () {
        yield* close;
        const path = input.viewModel.transcriptPathFor(taskId);
        if (path === undefined) return false;
        const expectedGeneration = generation;
        const scope = yield* Scope.make();
        const acquired = yield* input.reader
          .open(path, input.serialize(load(expectedGeneration, "refresh")))
          .pipe(Effect.provideService(Scope.Scope, scope), Effect.option);
        if (Option.isNone(acquired) || generation !== expectedGeneration) {
          yield* Scope.close(scope, Exit.succeed(undefined));
          return false;
        }
        active = { generation: expectedGeneration, taskId, scope, session: acquired.value };
        const loaded = yield* load(expectedGeneration, "latest");
        if (!loaded) {
          yield* close;
          return false;
        }
        return true;
      });

    const page = (direction: "older" | "newer") => {
      const current = active;
      return current === undefined ? Effect.void : load(current.generation, direction);
    };

    const refresh = Effect.suspend(() => {
      const current = active;
      return current === undefined ? Effect.void : load(current.generation, "refresh");
    });

    return { open, close, page, refresh };
  });
