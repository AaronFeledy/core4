import { Effect } from "effect";

import type { LandoEvent } from "@lando/sdk/services";

import { isProvisionalStartupCommand, provisionalTitleFrame } from "./task-tree-provisional.ts";
import {
  type TaskTreeSession,
  applyLifecycleBoundary,
  markSessionCommitted,
  openArmedSession,
} from "./task-tree-session.ts";

export type SessionSubstrate = {
  readonly consume: (event: LandoEvent) => Effect.Effect<void>;
  readonly openSession: (commandId: string) => void;
  readonly closeSession: () => ReadonlyArray<string>;
  readonly viewModel: { readonly expandedTaskId: string | undefined; collapse(): void };
  readonly controller: {
    exitFullTail(): Promise<void>;
    commitScrollback(text: string): void;
    rememberScrollback(text: string): void;
    setFooter(lines: ReadonlyArray<string>): void;
    dispose(): Promise<void>;
  };
  readonly transcriptTail: { readonly close: Effect.Effect<void> };
};

const assertNever = (value: never): never => {
  throw new Error(`Unexpected session boundary action: ${String(value)}`);
};

export const commitOpenSession = <E>(
  session: TaskTreeSession,
  substrate: SessionSubstrate | undefined,
  recordFailure: (cause: unknown) => E,
): Effect.Effect<TaskTreeSession> =>
  Effect.gen(function* () {
    if (substrate === undefined || session.kind !== "open" || session.committed) return session;
    if (substrate.viewModel.expandedTaskId !== undefined) {
      yield* Effect.tryPromise({
        try: () => substrate.controller.exitFullTail(),
        catch: recordFailure,
      }).pipe(Effect.ignore);
      yield* substrate.transcriptTail.close;
      substrate.viewModel.collapse();
    }
    for (const line of substrate.closeSession()) substrate.controller.commitScrollback(line);
    substrate.controller.setFooter([]);
    return markSessionCommitted(session);
  });

const paintProvisional = (
  session: TaskTreeSession,
  active: SessionSubstrate | undefined,
  acquire: Effect.Effect<SessionSubstrate | undefined>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (session.kind !== "armed" || !isProvisionalStartupCommand(session.commandId)) return;
    const substrate = active ?? (yield* acquire);
    if (substrate === undefined) return;
    substrate.controller.setFooter(provisionalTitleFrame(session.commandId));
  });

const consumeActive = (
  event: LandoEvent,
  session: TaskTreeSession,
  active: SessionSubstrate,
): Effect.Effect<TaskTreeSession> =>
  Effect.gen(function* () {
    let next = session;
    if (event._tag === "task.tree.start" && next.kind === "armed") {
      const commandId = next.commandId;
      next = openArmedSession(next);
      active.openSession(commandId);
    }
    yield* active.consume(event);
    return next;
  });

export const routeSessionEvent = <E>(
  event: LandoEvent,
  session: TaskTreeSession,
  active: SessionSubstrate | undefined,
  acquire: Effect.Effect<SessionSubstrate | undefined>,
  line: (event: LandoEvent) => void,
  recordFailure: (cause: unknown) => E,
): Effect.Effect<{ readonly session: TaskTreeSession }> =>
  Effect.gen(function* () {
    const boundary = applyLifecycleBoundary(session, event);
    switch (boundary.action) {
      case "none":
        break;
      case "arm":
        yield* paintProvisional(boundary.session, active, acquire);
        return { session: boundary.session };
      case "commit":
        return { session: yield* commitOpenSession(boundary.session, active, recordFailure) };
      case "clear":
        if (active !== undefined) active.controller.setFooter([]);
        return { session: boundary.session };
      case "ignore":
        return { session: boundary.session };
      default:
        return assertNever(boundary.action);
    }
    if (active !== undefined) {
      return { session: yield* consumeActive(event, session, active) };
    }
    if (event._tag !== "task.tree.start") {
      line(event);
      return { session };
    }
    const substrate = yield* acquire;
    if (substrate === undefined) {
      line(event);
      return { session };
    }
    return { session: yield* consumeActive(event, session, substrate) };
  });
