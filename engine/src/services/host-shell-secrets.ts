import { ShellExecError } from "@lando/sdk/errors";
import { REDACTED, parseSecretReference } from "@lando/sdk/secrets";
import type { ShellInteractiveSpec } from "@lando/sdk/services";
import { Effect } from "effect";

const SECRET_REFERENCE = /\$\{secret:([^}\r\n]+)\}/g;

const secretError = (message: string, cause?: unknown) =>
  new ShellExecError({
    message,
    command: REDACTED,
    cause,
    remediation: "Fix the Bun Shell command so it succeeds in the reported working directory, then re-run.",
  });

export const resolveHostShellSecrets = Effect.fnUntraced(function* (
  line: string,
  resolveSecret: ShellInteractiveSpec["resolveSecret"],
): Effect.fn.Return<
  { readonly fragments: ReadonlyArray<string>; readonly values: ReadonlyArray<string> },
  ShellExecError
> {
  SECRET_REFERENCE.lastIndex = 0;
  const matches = [...line.matchAll(SECRET_REFERENCE)];
  if (line.replace(SECRET_REFERENCE, "").includes("${secret:"))
    return yield* Effect.fail(secretError("Malformed secret reference."));
  const values = yield* Effect.forEach(matches, (match) =>
    Effect.gen(function* () {
      const reference = yield* Effect.fromResult(parseSecretReference(match[1] ?? ""));
      return yield* resolveSecret(reference.raw);
    }),
  ).pipe(Effect.mapError((error) => secretError(error.message, error)));
  const fragments: string[] = [];
  let cursor = 0;
  for (const match of matches) {
    fragments.push(line.slice(cursor, match.index));
    cursor = (match.index ?? cursor) + match[0].length;
  }
  fragments.push(line.slice(cursor));
  return { fragments, values };
});
