import {
  SecretNotFoundError,
  SecretReferenceInvalidError,
  SecretStoreUnavailableError,
} from "@lando/sdk/errors";
import { parseSecretReference } from "@lando/sdk/secrets";
import { ProcessRunner, SecretStore, type SecretStoreShape } from "@lando/sdk/services";
import { Effect, Layer, Match } from "effect";
import { classifyOpFailure } from "./classify.ts";
import { OP_READ_TIMEOUT_MS, type OpRunner, makeOpRunner } from "./op-cli.ts";

export const ONEPASSWORD_STORE_ID = "1password";
export const ONEPASSWORD_SCHEME = "op";

const remediation: Readonly<Record<SecretStoreUnavailableError["reason"], string>> = {
  "cli-missing":
    "Install the 1Password CLI and ensure op is on PATH. Run op signin or enable desktop app integration; use OP_SERVICE_ACCOUNT_TOKEN for non-interactive access.",
  unauthenticated:
    "Run op signin or enable 1Password desktop app integration. Use OP_SERVICE_ACCOUNT_TOKEN for non-interactive access.",
  locked:
    "Unlock the 1Password desktop app and approve CLI access, or run op signin. Use OP_SERVICE_ACCOUNT_TOKEN for non-interactive access.",
  denied:
    "Allow CLI access in 1Password desktop app integration and check vault permissions. Run op signin, or configure OP_SERVICE_ACCOUNT_TOKEN with vault access for non-interactive use.",
  timeout:
    "Unlock the 1Password desktop app and approve the CLI request, then retry. Run op signin or configure OP_SERVICE_ACCOUNT_TOKEN for non-interactive access.",
};

export const makeOnePasswordSecretStore = (options: {
  readonly run: OpRunner;
  readonly timeoutMs?: number;
}): SecretStoreShape => {
  // Values remain in this store instance only; no disk cache or vault enumeration.
  const cache = new Map<string, string>();
  const get: SecretStoreShape["get"] = (reference) =>
    Effect.gen(function* () {
      const parsed = yield* parseSecretReference(reference);
      if (parsed.scheme !== ONEPASSWORD_SCHEME)
        return yield* Effect.fail(
          new SecretReferenceInvalidError({
            message: "The 1Password store requires an op secret reference.",
            reference,
            remediation: "Use op://Vault/Item/field for a 1Password secret.",
          }),
        );
      const cached = cache.get(parsed.raw);
      if (cached !== undefined) return cached;
      const result = yield* options.run(["read", "--no-newline", parsed.raw], {
        timeoutMs: options.timeoutMs ?? OP_READ_TIMEOUT_MS,
      });
      if (result.exitCode === 0 && result.timedOut === false && result.cliMissing !== true) {
        cache.set(parsed.raw, result.stdout);
        return result.stdout;
      }
      const failure = classifyOpFailure({ ...result, cliMissing: result.cliMissing ?? false });
      return yield* Match.value(failure).pipe(
        Match.when({ kind: "not-found" }, () =>
          Effect.fail(
            new SecretNotFoundError({
              message: "The requested 1Password secret was not found.",
              secret: reference,
              remediation: "Check the vault, item, section, and field in the op reference.",
            }),
          ),
        ),
        Match.when({ kind: "unavailable" }, ({ reason }) =>
          Effect.fail(
            new SecretStoreUnavailableError({
              message: `1Password secret store unavailable: ${reason}.`,
              storeId: ONEPASSWORD_STORE_ID,
              reason,
              remediation: remediation[reason],
            }),
          ),
        ),
        Match.exhaustive,
      );
    });
  return {
    id: ONEPASSWORD_STORE_ID,
    schemes: [ONEPASSWORD_SCHEME],
    get,
    has: (reference) =>
      get(reference).pipe(
        Effect.as(true),
        Effect.catchTags({
          SecretNotFoundError: () => Effect.succeed(false),
          SecretReferenceInvalidError: () => Effect.succeed(false),
        }),
      ),
    list: Effect.sync(() => [...cache.keys()]),
  };
};

export const onePasswordSecretStore = Layer.effect(
  SecretStore,
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner;
    return makeOnePasswordSecretStore({ run: makeOpRunner(processRunner) });
  }),
);
