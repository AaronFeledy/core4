import { expect, test } from "bun:test";
import {
  createRedactor,
  isSecretEnvName,
  isSecretFieldName,
  isSecretStructuralName,
} from "@lando/sdk/secrets";

const oldParts = [
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
] as const;

test("env recognition preserves the old segment algorithm across a spelling corpus", () => {
  const corpus = oldParts.flatMap((part) =>
    [
      part,
      part.toUpperCase(),
      [...part].map((letter, index) => (index % 2 ? letter.toUpperCase() : letter)).join(""),
    ].flatMap((spelling) => [
      spelling,
      `DB_${spelling}`,
      `com.example.${spelling}.value`,
      `db-${spelling}-value`,
    ]),
  );
  corpus.push("REDISCLI_AUTH");
  for (const name of corpus) {
    expect(isSecretEnvName(name)).toBe(true);
  }
});

test.each([
  "dbPassword",
  "stripeSecretKey",
  "APIToken",
  "AUTHTOKEN",
  "REDISCLI_AUTH",
  "AUTHKEY",
  "AUTHKEYS",
  "APIKEYS",
  "CREDENTIALS",
  "PASSWORDS",
  "SECRETS",
  "TOKENS",
  "pass",
  "keys",
])("recognizes secret env name %s", (name) => expect(isSecretEnvName(name)).toBe(true));
// Concatenated names are not guessed: GitHub's Windows images export PGPASSWORD=root, which would mask "root" everywhere.
test.each([
  "TOKENIZERS_PARALLELISM",
  "MONKEY",
  "KEYBOARD",
  "COMPASS",
  "TEAM",
  "API_ENDPOINT",
  "PGPASSWORD",
  "DBPASSWORD",
  "MYSQL_PWD",
])("rejects ordinary env name %s", (name) => expect(isSecretEnvName(name)).toBe(false));
test.each([
  "rootPassword",
  "apiToken",
  "clientSecret",
  "credentials",
  "authToken",
  "apiKey",
  "api-key",
  "stripeSecretKey",
  "secretAccessKey",
  "privateKey",
  "signingKeys",
])("recognizes structural name %s", (name) => expect(isSecretStructuralName(name)).toBe(true));
test.each([
  "defaultSecretStore",
  "tokenFile",
  "cacheKey",
  "buildKey",
  "key",
  "certs.key",
  "keys",
  "pass",
  "TOKENIZERS_PARALLELISM",
  "sshKey",
  "storageKeys",
  "PGPASSWORD",
])("rejects structural metadata %s", (name) => expect(isSecretStructuralName(name)).toBe(false));

test("field recognition preserves the broad original pattern", () => {
  const old =
    /password|passwd|secret|token|credential|bearer|apikey|api[_-]?key|^authorization$|^auth(?:token|orization)?$/iu;
  const corpus = [
    ...oldParts,
    "auth",
    "authorization",
    "authToken",
    "api-key",
    "api_key",
    "tokenFile",
    "defaultSecretStore",
    "stripeSecretKey",
    "key",
    "certs.key",
    "AUTHKEY",
    "notauthorization",
  ].flatMap((name) => [name, name.toUpperCase(), `prefix${name}Suffix`]);
  for (const name of corpus) {
    expect(isSecretFieldName(name)).toBe(old.test(name));
    expect(createRedactor("secrets").redactValue({ [name]: "canary" })).toEqual({
      [name]: old.test(name) ? "[redacted]" : "canary",
    });
  }
});

test.each([
  ['PASSWORD="private tail"', "PASSWORD=[redacted]"],
  ["PASSWORD='x y'", "PASSWORD=[redacted]"],
  [String.raw`sh -c "echo PASSWORD=\"private tail\" >&2"`, String.raw`sh -c "echo PASSWORD=[redacted] >&2"`],
  [
    String.raw`{"command":"echo PASSWORD=\\\"private tail\\\" >&2"}`,
    String.raw`{"command":"echo PASSWORD=[redacted] >&2"}`,
  ],
  ['PASSWORD="[redacted]"', "PASSWORD=[redacted]"],
  ["WRAP=PASSWORD=x", "WRAP=PASSWORD=[redacted]"],
  ["?next=https://x/?token=y", "?next=https://x/?token=[redacted]"],
  ["PASSWORD=[redacted]tail", "PASSWORD=[redacted]"],
])("masks %s without consuming an enclosing ordinary key", (input, expected) => {
  const redactor = createRedactor("secrets");
  const output = redactor.redactString(input);
  expect(output).toBe(expected);
  expect(redactor.redactString(output)).toBe(expected);
  expect(redactor.redactStringBounded?.(input, 4096)).toBe(expected);
});

test("transcript masks nested query secrets and its distinct command grammar", () => {
  const query = "?next=https://x/?token=y&sig=z";
  expect(createRedactor("transcript").redactString(query)).toBe(
    "?next=https://x/?token=[redacted]&sig=[redacted]",
  );
  expect(
    createRedactor("transcript").redactString('password = "private tail" token \'x y\' -t "short value"'),
  ).toBe("password=[redacted] token [redacted] -t [redacted]");
});
