import type { SecretStoreUnavailableError } from "@lando/sdk/errors";

export type OpFailure =
  | { readonly kind: "not-found" }
  | { readonly kind: "unavailable"; readonly reason: SecretStoreUnavailableError["reason"] };

export const classifyOpFailure = (result: {
  readonly exitCode: number;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cliMissing: boolean;
}): OpFailure => {
  if (result.cliMissing) return { kind: "unavailable", reason: "cli-missing" };
  if (result.timedOut) return { kind: "unavailable", reason: "timeout" };
  if (/locked/i.test(result.stderr)) return { kind: "unavailable", reason: "locked" };
  if (/not signed in|sign[ -]?in|unauthenticated/i.test(result.stderr))
    return { kind: "unavailable", reason: "unauthenticated" };
  if (/denied|permission|access/i.test(result.stderr)) return { kind: "unavailable", reason: "denied" };
  if (/isn't an item|couldn't find|not found/i.test(result.stderr)) return { kind: "not-found" };
  // An unrecognized diagnostic does not prove that the secret is absent.
  return { kind: "unavailable", reason: "denied" };
};
