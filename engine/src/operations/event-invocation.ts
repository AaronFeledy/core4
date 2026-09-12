import {
  LandofileEventInvocationDepthError,
  LandofileEventLifecycleReentryError,
  ToolingCompileError,
} from "@lando/sdk/errors";
import type { AppPlan, LandofileEventName } from "@lando/sdk/schema";
import { Effect, FiberRef, Option } from "effect";
import { EventCommandExecutor } from "../services/event-command-executor.ts";
import type { ResolvedToolingCommandStepLeaf } from "../tooling/step-runner.ts";

export const MAX_EVENT_INVOCATION_DEPTH = 16;

interface ActiveEventFrame {
  readonly app: AppPlan["id"];
  readonly event: LandofileEventName;
  readonly file: string;
  readonly command?: string;
  readonly index?: number;
}

const activeEventFrames = FiberRef.unsafeMake<ReadonlyArray<ActiveEventFrame>>([]);

export const withinEventInvocation = <A, E, R>(frame: ActiveEventFrame, work: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const active = yield* FiberRef.get(activeEventFrames);
    const chain = [
      ...active.flatMap((entry) =>
        entry.command === undefined ? [entry.event] : [entry.event, entry.command],
      ),
      frame.event,
    ];
    const depth = active.length + 1;
    if (depth > MAX_EVENT_INVOCATION_DEPTH) {
      return yield* Effect.fail(
        new LandofileEventInvocationDepthError({
          message: `Event ${frame.event} in ${frame.file} exceeded the invocation depth limit.`,
          event: frame.event,
          chain,
          depth,
          limit: MAX_EVENT_INVOCATION_DEPTH,
          remediation: `Reduce nested event commands to at most MAX_EVENT_INVOCATION_DEPTH (${MAX_EVENT_INVOCATION_DEPTH}) active events.`,
        }),
      );
    }
    if (active.some((entry) => entry.app === frame.app && entry.event === frame.event)) {
      const command = active.at(-1)?.command ?? frame.event;
      return yield* Effect.fail(
        new LandofileEventLifecycleReentryError({
          message: `Command ${command} reentered event ${frame.event} in ${frame.file}.`,
          event: frame.event,
          command,
          chain,
          remediation: "Remove the lifecycle command cycle or call a non-lifecycle command from this event.",
        }),
      );
    }
    return yield* work.pipe(Effect.locally(activeEventFrames, [...active, frame]));
  });

export const runCanonicalCommand = (
  plan: AppPlan,
  leaf: ResolvedToolingCommandStepLeaf,
  redactionTokens: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const executor = yield* Effect.serviceOption(EventCommandExecutor);
    if (Option.isNone(executor)) {
      return yield* Effect.fail(
        new ToolingCompileError({
          message: `Canonical command event step ${leaf.command} is unavailable in this runtime.`,
          tool: leaf.command,
          remediation: "Use the app bootstrap layer that provides canonical command invocation.",
        }),
      );
    }
    const active = yield* FiberRef.get(activeEventFrames);
    const invokingFrames = active.map((frame, index) =>
      index === active.length - 1 ? { ...frame, command: leaf.command, index: leaf.authoredIndex } : frame,
    );
    const result = yield* executor.value
      .run({
        command: leaf.command,
        flags: leaf.flags,
        args: leaf.args,
        argv: leaf.raw,
        cwd: String(plan.root),
        silent: leaf.silent,
        plan,
        redactionTokens,
      })
      .pipe(Effect.locally(activeEventFrames, invokingFrames));
    return { ...result, tool: leaf.command, service: ":lando" };
  });
