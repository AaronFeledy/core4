import { protectSuppliedValues } from "@lando/engine/operations/tooling";
import { Effect, Layer } from "effect";
import type { CliInvocationContext } from "../runtime/invocation-context";
import {
  runCompiledCommand,
  setActiveCommandId,
  setActiveRendererMode,
  setActiveResultFormat,
} from "./compiled-runtime";
import type { InvocationHead, InvocationSplit } from "./invocation";
import type { InvocationOwner } from "./invocation-owner";
import { applyInvocationSelections } from "./invocation-selections";
import type { readConfigCliGlobals } from "./renderer-mode-resolution";
import { preCommandOutputMode } from "./spec/command-boundary";

/** A non-executable owner cannot interpret its command-side selections or list result keys. */
export const refuseToolingInvocation = async (input: {
  readonly route: Extract<InvocationOwner, { readonly kind: "tooling" }>["route"];
  readonly refusal: NonNullable<Extract<InvocationOwner, { readonly kind: "tooling" }>["refusal"]>;
  readonly split: InvocationSplit;
  readonly head: InvocationHead;
  readonly rawArgv: ReadonlyArray<string>;
  readonly context: CliInvocationContext;
  readonly configGlobals: Awaited<ReturnType<typeof readConfigCliGlobals>>;
}): Promise<void> => {
  // The leading selections were checked before routing; keep their normal precedence.
  if (
    await applyInvocationSelections(input.head.headGlobals, input.context, input.configGlobals, {
      protocolStdout: false,
      commandAbsent: false,
    })
  )
    return;
  // Only the existing failure-output resolver may use command-side flags. It cannot
  // fail, execute a projection, or turn bare --json into a successful key listing.
  const output = preCommandOutputMode({ argv: input.split.globals, env: input.context.env });
  if (output.rendererMode === "json") {
    setActiveRendererMode(output.rendererMode);
    setActiveResultFormat(output.resultFormat);
  }
  setActiveCommandId(input.route.commandId);
  await runCompiledCommand(
    Effect.gen(function* () {
      yield* protectSuppliedValues({
        _tag: "RawArgv",
        argv: input.rawArgv.slice(input.head.commandEndIndex + 1),
      });
      return yield* Effect.fail(input.refusal);
    }),
    Layer.empty,
    () => undefined,
    { context: input.context, preCommand: true },
  );
};
