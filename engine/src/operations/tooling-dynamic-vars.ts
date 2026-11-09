import { resolveServiceRef } from "@lando/landofile/tooling-input";
import { normalizeToolingTask } from "@lando/landofile/tooling-normalize";
import { makeDiagnosticTail } from "@lando/redaction";
import { planRedactionValues } from "@lando/redaction/plan-values";
import { mapFailures } from "@lando/sdk/command-result";
import { ToolingCompileError, ToolingExecError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import { type RuntimeProvider, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import type { DynamicToolingVarResolver } from "../tooling/step-runner.ts";
import { StreamFrameSink } from "./stream-frame-sink.ts";
import { type CompileToolingInput, executeToolingInvocations, stepInvocation } from "./tooling-compile.ts";
import type { AdmittedToolingInput } from "./tooling-input-admission.ts";

export const makeDynamicToolingVarResolver = (input: {
  readonly plan: AppPlan;
  readonly options: Omit<CompileToolingInput, "admitted">;
  readonly admitted: AdmittedToolingInput;
}) => {
  let provider: RuntimeProvider["Service"] | undefined;
  return Effect.fnUntraced(function* (variable: Parameters<DynamicToolingVarResolver<never, never>>[0]) {
    if (input.options.signal?.aborted) return yield* Effect.interrupt;
    const normalized = yield* Effect.fromResult(
      normalizeToolingTask(
        input.options.lookupKey,
        {
          cmd: variable.command,
          ...(variable.task.service === undefined ? {} : { service: variable.task.service }),
          ...(variable.task.user === undefined ? {} : { user: variable.task.user }),
          ...(variable.task.dir === undefined ? {} : { dir: variable.task.dir }),
          ...(variable.task.flags === undefined ? {} : { flags: variable.task.flags }),
          ...(variable.task.args === undefined ? {} : { args: variable.task.args }),
        },
        input.options.source,
      ),
    );
    const step = normalized.steps[0];
    if (step === undefined)
      return yield* Effect.die("A synthetic dynamic var task must have one command step.");
    const service = yield* Effect.fromResult(
      resolveServiceRef(step.service, input.admitted.values, normalized),
    );
    const invocation = stepInvocation(
      input.options.name,
      {
        ...step,
        ...(service === undefined ? {} : { resolvedService: service }),
      },
      {
        ...(input.options.cwd === undefined ? {} : { cwd: input.options.cwd }),
        ...(input.options.user === undefined ? {} : { user: input.options.user }),
        ...(input.options.signal === undefined ? {} : { signal: input.options.signal }),
        ...(input.options.agentEnvAllowlist === undefined
          ? {}
          : { agentEnvAllowlist: input.options.agentEnvAllowlist }),
        tty: false,
      },
    );
    const site = `tooling.${input.options.lookupKey}.vars.${variable.name}.sh`;
    const where =
      invocation.service === ":host"
        ? "on the host"
        : invocation.service === undefined
          ? "in the primary service"
          : `in service ${invocation.service}`;
    const needsProvider = invocation.service !== ":host";
    if (needsProvider && provider === undefined)
      provider = yield* (yield* RuntimeProviderRegistry).select(input.plan);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const encoder = new TextEncoder();
    // The canonical tail redacts with full pattern context before it clips, or fails closed.
    const diagnostics = yield* makeDiagnosticTail({
      authoritativeTokens: [...planRedactionValues(input.plan).substring, ...input.admitted.redactionTokens],
    });
    const result = yield* executeToolingInvocations({
      plan: input.plan,
      tool: input.options.name,
      invocations: [invocation],
      requiresProvider: needsProvider,
      redactionTokens: input.admitted.redactionTokens,
      ...(provider === undefined ? {} : { provider }),
    }).pipe(
      Effect.provideService(StreamFrameSink, {
        emit: (frame) =>
          Effect.sync(() => {
            const data =
              typeof frame.chunk === "string"
                ? encoder.encode(frame.chunk + (frame.kind === "record" ? "\n" : ""))
                : frame.chunk;
            if (frame._tag === "stdout") {
              bytes += data.byteLength;
              if (bytes <= 65536) chunks.push(data.slice());
            } else {
              diagnostics.write(data);
            }
          }),
      }),
      mapFailures((error) =>
        error._tag === "ToolingCompileError"
          ? new ToolingCompileError({
              tool: error.tool,
              message: `${site}: ${error.message}`,
              remediation: error.remediation,
              ...(error.source === undefined ? {} : { source: error.source }),
            })
          : new ToolingExecError({
              tool: input.options.name,
              variable: variable.name,
              message: `${site} could not run ${where}: ${error.message}`,
              remediation:
                "remediation" in error &&
                typeof error.remediation === "string" &&
                error.remediation.trim() !== ""
                  ? error.remediation
                  : `Check ${site} in ${input.options.source.path}.`,
              ...(error instanceof ToolingExecError && error.exitCode !== undefined
                ? { exitCode: error.exitCode }
                : {}),
              cause: error,
            }),
      ),
    );
    const decode = (parts: readonly Uint8Array[]) => {
      const decoder = new TextDecoder();
      return parts.map((part) => decoder.decode(part, { stream: true })).join("") + decoder.decode();
    };
    if (input.options.signal?.aborted) return yield* Effect.interrupt;
    const overflow = bytes > 65536;
    if (overflow || result.exitCode !== 0) {
      const diagnostic = diagnostics.finish()?.trimEnd() ?? "";
      return yield* Effect.fail(
        new ToolingExecError({
          tool: input.options.name,
          variable: variable.name,
          ...(overflow && result.exitCode === 0 ? {} : { exitCode: result.exitCode }),
          message: `${site} ${overflow ? "printed more than 64 KiB to stdout" : `exited with code ${result.exitCode}`} ${where}.${diagnostic === "" ? "" : ` ${diagnostic}`}`,
          remediation: overflow
            ? `Make the command at ${site} in ${input.options.source.path} print at most 64 KiB.`
            : `Run the command ${where} to see why it fails, then fix ${site} in ${input.options.source.path}.`,
        }),
      );
    }
    return decode(chunks).replace(/(?:\r?\n)+$/u, "");
  });
};
