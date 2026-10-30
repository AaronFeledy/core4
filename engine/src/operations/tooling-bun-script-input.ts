import type { DiscoveredBunShellScript } from "@lando/landofile/bun-sh-discovery";
import { normalizeBunShellScript } from "@lando/landofile/bun-sh-metadata";
import { RedactionService } from "@lando/redaction/service";
import { NotImplementedError } from "@lando/sdk/errors";
import {
  type ToolingInputRevision,
  ToolingInputValues,
  type ToolingInvocationInput,
} from "@lando/sdk/schema";
import { Effect, Option, Schema } from "effect";
import { withShellRedactionTokens } from "../services/shell-runner.ts";
import { ToolingBooleanEnvironment } from "../services/tooling-input-environment.ts";
import { admitToolingInput } from "./tooling-input-admission.ts";

export const prepareBunShellScript = Effect.fnUntraced(function* (
  script: DiscoveredBunShellScript,
  options: { readonly input?: ToolingInvocationInput; readonly expectedInputRevision?: ToolingInputRevision },
) {
  const metadata = yield* Effect.fromResult(normalizeBunShellScript(script));
  const admitted = yield* admitToolingInput(metadata, options);
  if (metadata.rawService !== ":host")
    return yield* Effect.fail(
      new NotImplementedError({
        message: `.bun.sh script "${script.id}" declares service "${metadata.rawService}"; service-targeted .bun.sh scripts are not supported.`,
        commandId: "tooling.run",
        remediation:
          "Remove the service field or set it to :host, or use a Landofile tooling task for service execution.",
      }),
    );
  const argv =
    admitted.invocation._tag === "RawArgv"
      ? admitted.invocation.argv
      : (admitted.invocation.passthroughArgv ?? []);
  return { script, metadata, input: admitted.values, argv, redactionTokens: admitted.redactionTokens };
});

export type PreparedBunShellScript = Effect.Success<ReturnType<typeof prepareBunShellScript>>;

export const withBunShellScriptInputs = Effect.fnUntraced(function* <
  A extends { readonly stdout: string; readonly stderr: string },
  E,
  R,
>(prepared: PreparedBunShellScript, execute: Effect.Effect<A, E, R>): Effect.fn.Return<A, E, R> {
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (Option.isSome(redaction)) yield* redaction.value.registerValues(prepared.redactionTokens);
  const booleanFlags = new Set(
    prepared.metadata.input.flags.filter((flag) => flag.boolean).map((flag) => flag.name),
  );
  const booleanEnvironment = Object.fromEntries<boolean>(
    Object.entries(prepared.metadata.inputEnvSuffixes.flags).flatMap(([name, suffix]) => {
      const value = Object.hasOwn(prepared.input.flags, name) ? prepared.input.flags[name] : undefined;
      return booleanFlags.has(name) && typeof value === "boolean"
        ? [[`LANDO_FLAG_${suffix}`, value] as const]
        : [];
    }),
  );
  const result = yield* withShellRedactionTokens(prepared.redactionTokens, execute).pipe(
    Effect.provideService(ToolingBooleanEnvironment, booleanEnvironment),
  );
  if (Option.isNone(redaction)) return result;
  const redactor = yield* redaction.value.forProfile("secrets", {
    redactionTokens: prepared.redactionTokens,
  });
  return {
    ...result,
    stdout: redactor.redactString(result.stdout),
    stderr: redactor.redactString(result.stderr),
  };
});

export const bunShellScriptEnvironment = (
  prepared: PreparedBunShellScript,
  inherited: Readonly<Record<string, string | undefined>>,
  resolved: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => {
  const shadowed = Object.fromEntries(
    [...Object.keys(inherited), ...Object.keys(resolved)]
      .filter((name) => name.startsWith("LANDO_FLAG_") || name.startsWith("LANDO_ARG_"))
      .map((name) => [name, ""]),
  );
  const declared = Object.fromEntries(
    (["flags", "args"] as const).flatMap((group) =>
      Object.entries(prepared.metadata.inputEnvSuffixes[group]).map(([name, suffix]) => [
        `LANDO_${group === "flags" ? "FLAG" : "ARG"}_${suffix}`,
        String(Object.hasOwn(prepared.input[group], name) ? prepared.input[group][name] : ""),
      ]),
    ),
  );
  return {
    ...resolved,
    ...shadowed,
    ...declared,
    LANDO_INPUT: JSON.stringify(Schema.encodeSync(ToolingInputValues)(prepared.input)),
  };
};
