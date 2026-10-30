import {
  type ToolingInputSubject,
  bindToolingInput,
  validateToolingInputRevision,
} from "@lando/landofile/tooling-input";
import { toolingInputRedactionTokens } from "@lando/landofile/tooling-input-redaction";
import { RedactionService } from "@lando/redaction/service";
import { ToolingDisabledError } from "@lando/sdk/errors";
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
