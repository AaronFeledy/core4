import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { PluginPackageOperationError } from "@lando/sdk/errors";
import { Effect } from "effect";

export const redactPluginPackageError = Effect.fnUntraced(function* (
  error: PluginPackageOperationError,
  output?: { readonly stderr: string; readonly stdout: string },
) {
  const redaction = yield* Effect.serviceOption(RedactionService);
  const redactor =
    redaction._tag === "None"
      ? createStandaloneRedactor("secrets", { sourceEnv: process.env })
      : yield* redaction.value.forProfile("secrets", { sourceEnv: process.env });
  const parts =
    output === undefined
      ? error.detail === undefined
        ? []
        : [error.detail]
      : [output.stderr, output.stdout];
  const retained: string[] = [];
  const marker = "[diagnostic clipped]";
  let remaining = 8192;
  for (const part of parts.filter((text) => text !== "")) {
    const budget = remaining - (retained.length === 0 ? 0 : 1) - Buffer.byteLength(marker) - 1;
    const safe = redactor.redactStringBounded?.(part, 2 * 1024 * 1024);
    if (safe === undefined) {
      retained.push(marker);
      break;
    }
    const bytes = new TextEncoder().encode(safe);
    if (bytes.byteLength > budget) {
      const prefix = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, Math.max(0, budget)),
        { stream: true },
      );
      retained.push(`${prefix}\n${marker}`);
      break;
    }
    retained.push(safe);
    remaining -= Buffer.byteLength(safe) + (retained.length === 1 ? 0 : 1);
  }
  const detail = retained.length === 0 ? undefined : retained.join("\n");
  return new PluginPackageOperationError({
    message: redactor.redactString(error.message),
    remediation: redactor.redactString(error.remediation),
    commandId: error.commandId,
    operation: error.operation,
    packageSpec: redactor.redactString(error.packageSpec),
    cwd: redactor.redactString(error.cwd),
    ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
    ...(detail === undefined ? {} : { detail }),
  });
});
