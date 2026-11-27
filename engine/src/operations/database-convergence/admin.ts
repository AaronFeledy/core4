import { SqlCredentialAdminAuthError } from "@lando/sdk/errors";
import type { DatabaseCredentialConvergenceRequest } from "@lando/sdk/services";
import { Effect, Redacted } from "effect";
import type { AdapterContext, AdminCredential, CredentialAdapter } from "./types.ts";

export const validPassword = (value: string, max = 4096) =>
  value.length > 0 && !/[\p{Cc}\p{Cs}]/u.test(value) && new TextEncoder().encode(value).length <= max;

export const chooseAdmin = Effect.fnUntraced(function* (input: {
  readonly context: AdapterContext;
  readonly adapter: CredentialAdapter;
  readonly fallback?: Pick<DatabaseCredentialConvergenceRequest, "adminUser" | "readPassword">;
  readonly register: (value: string) => Effect.Effect<void>;
}) {
  const {
    context: { family, desired, applied, service },
    adapter,
    fallback,
  } = input;
  const named = family === "postgres" || family === "mongodb";
  const native = family === "mssql" ? "sa" : "root";
  const user = named ? applied.user : native;
  const oldPassword = named ? applied.password : (applied.rootPassword ?? applied.password);
  const password = named ? desired.password : (desired.rootPassword ?? desired.password);
  const candidates: AdminCredential[] = [
    ...(oldPassword === undefined ? [] : [{ user, password: oldPassword }]),
    { user: named ? desired.user : native, password },
    ...(family === "postgres" ? [{ user: "postgres", password: "" }] : []),
  ];
  const checked: AdminCredential[] = [];
  let insufficientPrivilege = false;
  for (const candidate of candidates) {
    if (checked.some((entry) => entry.user === candidate.user && entry.password === candidate.password))
      continue;
    checked.push(candidate);
    const proof = yield* adapter.admin(candidate);
    if (proof === "accepted") return candidate;
    if (proof === "insufficient-privilege") insufficientPrivilege = true;
  }
  const supplied = yield* fallback?.readPassword ?? Effect.succeed(undefined);
  if (supplied !== undefined) {
    const password = Redacted.value(supplied);
    if (validPassword(password)) {
      yield* input.register(password);
      const candidate = { user: fallback?.adminUser ?? user, password, explicit: true };
      if ((yield* adapter.admin(candidate)) === "accepted") {
        const wrong =
          password === "lando-credential-control"
            ? "lando-credential-negative-control"
            : "lando-credential-control";
        yield* input.register(wrong);
        if ((yield* adapter.admin({ ...candidate, password: wrong })) === "rejected") return candidate;
      }
    }
  }
  return yield* new SqlCredentialAdminAuthError({
    service,
    family,
    reason:
      supplied === undefined
        ? insufficientPrivilege
          ? "insufficient-privilege"
          : "admin-password-required"
        : "rejected",
    message: "Could not prove an authorized database administrator login.",
    remediation:
      "Supply the current administrator password to `lando db:creds:apply -` to preview repair, then use `--yes -` to apply it.",
  });
});
