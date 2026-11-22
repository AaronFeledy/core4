import { mapFailures } from "@lando/sdk/command-result";
import { CommandInputValidationError, CommandStdioError } from "@lando/sdk/errors";
import type { ExecutableCommandInput } from "@lando/sdk/plugins";
import { InteractionService } from "@lando/sdk/services";
import { Effect, Redacted, Result, Stream } from "effect";

const maxBytes = 4096;
const command = "db:creds:apply";

export const readAdminPassword = Effect.fnUntraced(function* (input: ExecutableCommandInput) {
  if (input.args.adminPasswordSource === undefined) {
    const interaction = yield* InteractionService;
    if (!(yield* interaction.isInteractive)) return undefined;
    const result = yield* Effect.result(
      interaction.secret({ message: "Current database administrator password" }),
    );
    return Result.isSuccess(result) ? result.success : undefined;
  }
  const remediation =
    "Pipe one current administrator password into `lando db:creds:apply -` to preview, or use `--yes -` to apply.";
  const invalid = new CommandInputValidationError({
    target: command,
    field: "adminPasswordSource",
    kind: "arg",
    reason: "invalid",
    message: "Expected one nonempty UTF-8 administrator password (at most 4096 bytes).",
    remediation,
  });
  const stream = input.stdio?.stdin;
  if (input.args.adminPasswordSource !== "-") return yield* invalid;
  if (stream === undefined)
    return yield* new CommandStdioError({
      command,
      stream: "stdin",
      reason: "unavailable",
      message: "Administrator password stdin was not granted.",
      remediation,
    });
  const bytes = new Uint8Array(maxBytes + 2);
  let size = 0;
  yield* Stream.runForEach(stream, (chunk) => {
    if (size + chunk.length > bytes.length) return Effect.fail(invalid);
    bytes.set(chunk, size);
    size += chunk.length;
    return Effect.void;
  }).pipe(
    Effect.timeout("10 seconds"),
    mapFailures((error) =>
      error instanceof CommandStdioError || error instanceof CommandInputValidationError
        ? error
        : new CommandStdioError({
            command,
            stream: "stdin",
            reason: "read",
            message: "Timed out reading the administrator password.",
            remediation,
          }),
    ),
  );
  const password = yield* Effect.try({
    try: () =>
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
        .decode(bytes.subarray(0, size))
        .replace(/\r?\n$/u, ""),
    catch: () => invalid,
  });
  if (
    password.length === 0 ||
    /[\p{Cc}\p{Cs}]/u.test(password) ||
    new TextEncoder().encode(password).length > maxBytes
  )
    return yield* invalid;
  return Redacted.make(password);
});
