/** Values collected from secret-looking keys, minus published defaults and public credential identities. */
import { DATABASE_FAMILY_ENV_KEYS, LANDO_DB_ENV_KEYS } from "@lando/sdk/database-creds";
import { isPublicDefaultCredential, isUsableExactRedactionValue } from "@lando/sdk/secrets";

export const nonEmpty = (value: string | undefined): value is string =>
  value !== undefined && value.trim().length > 0;

const SECRET_ENV_KEY_PARTS = new Set([
  "apikey",
  "apikeys",
  "authkey",
  "authkeys",
  "authtoken",
  "authtokens",
  "credential",
  "credentials",
  "key",
  "keys",
  "pass",
  "passwd",
  "passwds",
  "password",
  "passwords",
  "secret",
  "secrets",
  "token",
  "tokens",
]);

type CredentialFields<T> = {
  readonly user?: T | undefined;
  readonly password?: T | undefined;
  readonly database?: T | undefined;
  readonly rootPassword?: T | undefined;
};

// MariaDB publishes MYSQL_* and MARIADB_* side by side; pairing keys by index keeps their identities apart.
const ENV_CREDENTIAL_TUPLES: ReadonlyArray<CredentialFields<string>> = [
  LANDO_DB_ENV_KEYS,
  ...Object.values(DATABASE_FAMILY_ENV_KEYS).flatMap((keys) =>
    Array.from({ length: Math.max(keys.password.length, keys.rootPassword.length) }, (_, index) => ({
      user: keys.user[index],
      password: keys.password[index],
      database: keys.database[index],
      rootPassword: keys.rootPassword[index],
    })),
  ),
];

const read = (environment: Readonly<Record<string, unknown>>, key: string | undefined): unknown =>
  key === undefined ? undefined : environment[key];

/** A password is public only when it equals its own credential's user or database name. */
export const collectPublicCredentialValues = (
  environment: Readonly<Record<string, unknown>> | undefined,
  creds?: CredentialFields<unknown>,
): ReadonlySet<string> => {
  const tuples: CredentialFields<unknown>[] = creds === undefined ? [] : [creds];
  if (environment !== undefined) {
    for (const keys of ENV_CREDENTIAL_TUPLES) {
      tuples.push({
        user: read(environment, keys.user),
        password: read(environment, keys.password),
        database: read(environment, keys.database),
        rootPassword: read(environment, keys.rootPassword),
      });
    }
  }
  const values = new Set<string>();
  for (const tuple of tuples) {
    for (const password of [tuple.password, tuple.rootPassword]) {
      if (
        typeof password === "string" &&
        nonEmpty(password) &&
        (password === tuple.user || password === tuple.database)
      ) {
        values.add(password);
      }
    }
  }
  return values;
};

export const collectSecretEnvValues = (
  sourceEnv: Record<string, string | undefined> | undefined,
  publicValues?: ReadonlySet<string>,
): string[] => {
  if (sourceEnv === undefined) return [];
  const localPublicValues = collectPublicCredentialValues(sourceEnv);
  const values: string[] = [];
  for (const [key, value] of Object.entries(sourceEnv)) {
    const normalizedParts = key
      .toLowerCase()
      .split(/[._-]+/u)
      .filter(nonEmpty);
    const carriesSecret =
      key.toUpperCase() === "REDISCLI_AUTH" || normalizedParts.some((part) => SECRET_ENV_KEY_PARTS.has(part));
    if (
      carriesSecret &&
      nonEmpty(value) &&
      !isPublicDefaultCredential(value) &&
      !localPublicValues.has(value) &&
      !publicValues?.has(value) &&
      isUsableExactRedactionValue(value)
    ) {
      values.push(value);
    }
  }
  return values;
};
