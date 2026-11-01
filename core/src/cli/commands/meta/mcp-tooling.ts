import { runTooling } from "@lando/engine/operations/tooling";
import { toolingInputRedactionTokens } from "@lando/landofile/tooling-input-redaction";
import type { McpRunInput } from "@lando/mcp/dispatch";
import type { McpCommandSpec } from "@lando/mcp/registry";
import { RedactionService } from "@lando/redaction/service";
import { commandCompletionFromExitCode } from "@lando/sdk/command-result";
import { type ToolingInputDeclaration, type ToolingInvocationInput, ToolingResult } from "@lando/sdk/schema";
import type { RegisteredCommand } from "@lando/sdk/services";
import { Effect, Option, Predicate, Schema } from "effect";

const invocationFromMaps = (declaration: ToolingInputDeclaration, input: unknown): ToolingInvocationInput => {
  const maps = Predicate.isObject(input) ? input : {};
  const flags = Predicate.isObject(maps.flags) ? maps.flags : {};
  const args = Predicate.isObject(maps.args) ? maps.args : {};
  if (declaration.flags.length + declaration.args.length > 0) return { _tag: "NamedMaps", flags, args };
  const tail = Object.hasOwn(args, "args") ? args.args : undefined;
  if (Array.isArray(tail) && tail.every((value): value is string => typeof value === "string"))
    return {
      _tag: "NamedMaps",
      flags,
      args: Object.fromEntries(Object.entries(args).filter(([key]) => key !== "args")),
      passthroughArgv: tail,
    };
  return { _tag: "NamedMaps", flags, args };
};

export const toolingSpecFromRegistered = (command: RegisteredCommand): McpCommandSpec => {
  const declaration = command.input;
  return {
    id: command.id,
    summary: command.summary,
    ...(declaration === undefined ? {} : { toolingInput: declaration }),
    resultSchema: ToolingResult,
    completion: (result) =>
      commandCompletionFromExitCode(Schema.decodeUnknownSync(ToolingResult)(result).exitCode),
    inputRedactionTokens: (input) =>
      declaration === undefined
        ? []
        : toolingInputRedactionTokens([declaration], invocationFromMaps(declaration, input)),
    run: Effect.fnUntraced(function* (input: McpRunInput) {
      const invocation: ToolingInvocationInput =
        declaration === undefined
          ? { _tag: "NamedMaps", flags: input.flags, args: input.args }
          : invocationFromMaps(declaration, input);
      const redaction = yield* Effect.serviceOption(RedactionService);
      if (Option.isSome(redaction) && declaration !== undefined)
        yield* redaction.value.registerValues(toolingInputRedactionTokens([declaration], invocation));
      return yield* runTooling({
        name: command.id,
        input: invocation,
        ...(declaration === undefined ? {} : { expectedInputRevision: declaration.revision }),
      });
    }),
    redactionTokens: (result) =>
      Schema.decodeUnknownSync(
        Schema.Struct({ redactionTokens: Schema.optionalKey(Schema.Array(Schema.String)) }),
      )(result).redactionTokens ?? [],
  };
};
