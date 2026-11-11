import type { ToolingInputRevision, ToolingInvocationInput } from "@lando/sdk/schema";
import { Effect } from "effect";
import { type CompileToolingInput, compileToolingInvocations } from "../../src/operations/tooling-compile.ts";
import { admitToolingTask } from "../../src/operations/tooling-input-admission.ts";

export const admitAndCompileTooling = Effect.fnUntraced(function* (
  input: Omit<CompileToolingInput, "admitted"> & {
    readonly input?: ToolingInvocationInput;
    readonly expectedInputRevision?: ToolingInputRevision;
  },
) {
  const admitted = yield* admitToolingTask(input);
  return yield* compileToolingInvocations({ ...input, admitted });
});
