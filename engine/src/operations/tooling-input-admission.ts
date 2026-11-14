import {
  consumedToolingInputs,
  dynamicToolingReferenceIssues,
  toolingInvocationIssues,
} from "@lando/landofile/compiled-sites";
import {
  type ToolingInputSubject,
  bindToolingInput,
  lowerToolingInput,
  validateToolingInputRevision,
} from "@lando/landofile/tooling-input";
import { toolingInputRedactionTokens } from "@lando/landofile/tooling-input-redaction";
import type { ToolingNormalizationSource } from "@lando/landofile/tooling-normalize";
import { normalizeToolingTask, toolingCompileResult } from "@lando/landofile/tooling-normalize";
import { RedactionService } from "@lando/redaction/service";
import { ToolingCompileError, ToolingDisabledError } from "@lando/sdk/errors";
import type {
  ParsedPendingSite,
  ToolingInputDeclaration,
  ToolingInputRevision,
  ToolingInvocationInput,
  ToolingTaskShape,
} from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect, Option, Result } from "effect";
import { projectToolingDiagnostic } from "../tooling/diagnostics.ts";

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

export const protectSuppliedValues = Effect.fnUntraced(function* (input: ToolingInvocationInput | undefined) {
  // Invalid declarations cannot classify inputs reliably; protect every supplied string before refusal.
  const invocation = input ?? { _tag: "RawArgv", argv: [] };
  const pending: unknown[] = [];
  switch (invocation._tag) {
    case "RawArgv":
      for (const token of invocation.argv) {
        const equals = token.indexOf("=");
        pending.push(token);
        if (token.startsWith("-") && equals >= 0) pending.push(token.slice(equals + 1));
      }
      break;
    case "NamedMaps":
      pending.push(invocation.flags, invocation.args, invocation.passthroughArgv);
      break;
    default:
      invocation satisfies never;
  }
  const seen = new WeakSet<object>();
  const tokens: string[] = [];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") tokens.push(value);
    else if (value !== null && typeof value === "object" && !seen.has(value)) {
      seen.add(value);
      pending.push(...Object.values(value));
    }
  }
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (Option.isSome(redaction)) yield* redaction.value.registerValues(tokens);
  return tokens;
});

export const admitToolingTask = Effect.fnUntraced(function* (input: {
  readonly name: string;
  readonly task: ToolingTaskShape;
  readonly source: ToolingNormalizationSource & { readonly task: string };
  readonly input?: ToolingInvocationInput;
  readonly expectedInputRevision?: ToolingInputRevision;
  readonly sites?: readonly ParsedPendingSite[];
}) {
  if (input.task.disabled === true) {
    yield* protectSuppliedValues(input.input);
    return yield* Effect.fail(
      new ToolingDisabledError({
        message: `Tooling command ${input.name} is disabled.`,
        tool: input.name,
        source: input.source,
        remediation: `Enable tooling command ${input.name} in ${input.source.path} before running it.`,
      }),
    );
  }
  const normalized = normalizeToolingTask(input.name, input.task, input.source);
  const sites = input.sites ?? [];
  const issues = [
    ...toolingInvocationIssues(input.task, sites),
    ...dynamicToolingReferenceIssues(input.task, sites),
  ];
  const [first, ...rest] = issues;
  const checked =
    Result.isFailure(normalized) || first === undefined
      ? normalized
      : toolingCompileResult(input.name, Result.fail([first, ...rest]), input.source);
  if (Result.isFailure(checked)) {
    const suppliedValues = yield* protectSuppliedValues(input.input);
    const redaction = yield* Effect.serviceOption(RedactionService);
    const redactor = Option.isSome(redaction)
      ? yield* redaction.value.forProfile("secrets")
      : createRedactor("secrets", { values: suppliedValues });
    return yield* Effect.fail(new ToolingCompileError(projectToolingDiagnostic(checked.failure, redactor)));
  }
  const declaration = checked.success.input;
  const subject = { name: input.name, source: input.source };
  const admitted = yield* admitToolingInput({ ...subject, input: declaration, disabled: false }, input);
  const consumed = consumedToolingInputs(input.task, sites);
  const remaining = {
    ...declaration,
    flags: declaration.flags.filter((flag) => !consumed.flags.has(flag.name)),
    args: declaration.args.filter((arg) => !consumed.args.has(arg.name)),
  };
  const argv =
    declaration.flags.length + declaration.args.length > 0
      ? yield* Effect.fromResult(lowerToolingInput(subject, remaining, admitted.values))
      : consumed.raw
        ? []
        : admitted.invocation._tag === "RawArgv"
          ? admitted.invocation.argv
          : (admitted.invocation.passthroughArgv ?? []);
  return { ...admitted, argv, declaration };
});

export type AdmittedToolingInput = Effect.Success<ReturnType<typeof admitToolingTask>>;
