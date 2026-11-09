import {
  type ToolingInputSubject,
  bindToolingInput,
  lowerToolingInput,
  validateToolingInputRevision,
} from "@lando/landofile/tooling-input";
import { normalizeToolingInput } from "@lando/landofile/tooling-input-normalize";
import { toolingInputRedactionTokens } from "@lando/landofile/tooling-input-redaction";
import { RedactionService } from "@lando/redaction/service";
import { ToolingDisabledError } from "@lando/sdk/errors";
import type { ToolingTaskShape } from "@lando/sdk/schema";
import type {
  ToolingInputDeclaration,
  ToolingInputRevision,
  ToolingInvocationInput,
} from "@lando/sdk/schema";
import { Effect, Option } from "effect";

export const admitToolingInput = Effect.fnUntraced(function* (
  target: ToolingInputSubject & {
    readonly input: ToolingInputDeclaration;
    readonly disabled: boolean;
  },
  options: { readonly input?: ToolingInvocationInput; readonly expectedInputRevision?: ToolingInputRevision },
) {
  const invocation: ToolingInvocationInput = options.input ?? { _tag: "RawArgv", argv: [] };
  const redactionTokens = toolingInputRedactionTokens([target.input], invocation);
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (Option.isSome(redaction)) yield* redaction.value.registerValues(redactionTokens);
  if (target.disabled)
    return yield* Effect.fail(
      new ToolingDisabledError({
        message: `Tooling command ${target.name} is disabled.`,
        tool: target.name,
        source: target.source ?? { path: "<tooling>", task: target.name },
        remediation: `Enable tooling command ${target.name}${target.source === undefined ? "" : ` in ${target.source.path}`} before running it.`,
      }),
    );
  yield* Effect.fromResult(validateToolingInputRevision(target, target.input, options.expectedInputRevision));
  const values = yield* Effect.fromResult(bindToolingInput(target, target.input, invocation));
  return { invocation, values, redactionTokens };
});

export const admitToolingTask = Effect.fnUntraced(function* (input: {
  readonly name: string;
  readonly task: ToolingTaskShape;
  readonly source: { readonly path: string; readonly task: string };
  readonly input?: ToolingInvocationInput;
  readonly expectedInputRevision?: ToolingInputRevision;
}) {
  const declaration = yield* Effect.fromResult(normalizeToolingInput(input.name, input.task, input.source));
  const subject = { name: input.name, source: input.source };
  const admitted = yield* admitToolingInput(
    { ...subject, input: declaration, disabled: input.task.disabled === true },
    input,
  );
  // Lowering reads only the declaration, so input argv cannot carry fails before a dynamic var runs.
  const argv =
    declaration.flags.length + declaration.args.length > 0
      ? yield* Effect.fromResult(lowerToolingInput(subject, declaration, admitted.values))
      : admitted.invocation._tag === "RawArgv"
        ? admitted.invocation.argv
        : (admitted.invocation.passthroughArgv ?? []);
  return { ...admitted, argv };
});

export type AdmittedToolingInput = Effect.Success<ReturnType<typeof admitToolingTask>>;
