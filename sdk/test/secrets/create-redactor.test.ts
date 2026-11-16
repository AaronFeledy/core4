import { describe, expect, test } from "bun:test";

import {
  PATTERN_CLASSES,
  REDACTED,
  REDACTION_PROFILES,
  createRedactor,
  isSecretFieldName,
  isSecretStructuralName,
} from "@lando/sdk/secrets";
import { LOG_LINE_TRUNCATED_MARKER } from "../../src/log-follow/marker.ts";
import { replacePatternsBounded } from "../../src/secrets/bounded-redaction.ts";

const signedUrlCases = [
  {
    name: "issue #1677 AWS S3 URL",
    input:
      'Get "https://cdn01.quay.io/x?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20261022%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261022T070000Z&X-Amz-Signature=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789": EOF',
    expected:
      'Get "https://cdn01.quay.io/x?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=[redacted]&X-Amz-Date=20261022T070000Z&X-Amz-Signature=[redacted]": EOF',
  },
  {
    name: "AWS session credentials",
    input:
      "https://s3.example/x?X-Amz-Credential=key&X-Amz-Security-Token=session&X-Amz-Signature=signature&n=1",
    expected:
      "https://s3.example/x?X-Amz-Credential=[redacted]&X-Amz-Security-Token=[redacted]&X-Amz-Signature=[redacted]&n=1",
  },
  {
    name: "GCS signed URL",
    input:
      "https://storage.googleapis.com/x?X-Goog-Credential=key%2Fdate&X-Goog-Date=20261022T070000Z&X-Goog-Signature=signature",
    expected:
      "https://storage.googleapis.com/x?X-Goog-Credential=[redacted]&X-Goog-Date=20261022T070000Z&X-Goog-Signature=[redacted]",
  },
  {
    name: "Azure SAS URL",
    input: "https://blob.example/x?sv=2026-01-01&sig=signature%2Bvalue&sp=r",
    expected: "https://blob.example/x?sv=2026-01-01&sig=[redacted]&sp=r",
  },
] as const;

describe("sequential secret pattern regressions", () => {
  const cases = [
    ...signedUrlCases,
    {
      name: "overlapping assignment and bearer",
      input: "Bearer TOKEN=abc!tail",
      expected: "Bearer [redacted]",
    },
    {
      name: "ampersand in an assignment",
      input: "PASSWORD=abc&private-tail",
      expected: "PASSWORD=[redacted]",
    },
    { name: "assignment in userinfo", input: "https://u:PASSWORD=x@h", expected: "https://[redacted]@h" },
    {
      name: "qualified keys",
      input: "--db-password=x config.db.password=x MY_API_KEY=x",
      expected: "--db-password=[redacted] config.db.password=[redacted] MY_API_KEY=[redacted]",
    },
    { name: "partially masked assignment", input: "PASSWORD=[redacted]XYZ", expected: "PASSWORD=[redacted]" },
    { name: "partially masked bearer", input: "Bearer abc[redacted]def", expected: "Bearer [redacted]" },
    {
      name: "partially masked encoded userinfo",
      input: "https%3A%2F%2Fu%3Aabc[redacted]def%40h",
      expected: "https%3A%2F%2F[redacted]%40h",
    },
    {
      name: "value-layer masked query",
      input: "?api_key=s3cr3tvalue&n=1",
      expected: "?api_key=[redacted]&n=1",
    },
    { name: "bare query", input: "?token=abc", expected: "?token=[redacted]" },
    { name: "suffixed quoted query", input: '?token="x"suffix', expected: "?token=[redacted]" },
    {
      name: "legitimate closing bracket",
      input: "Env=[A_PASSWORD=x]",
      expected: "Env=[A_PASSWORD=[redacted]]",
    },
  ];

  for (const { name, input, expected } of cases) {
    test(`masks ${name} idempotently without losing surrounding syntax`, () => {
      // Given
      const redactor = createRedactor("secrets", { values: ["s3cr3tvalue"] });
      // When
      const output = redactor.redactString(input);
      const bounded = redactor.redactStringBounded?.(input, 4_096);
      // Then
      expect(output).toBe(expected);
      expect(bounded).toBe(expected);
      expect(redactor.redactString(output)).toBe(expected);
      expect(redactor.redactStringBounded?.(output, 4_096)).toBe(expected);
    });

    test(`telemetry is a fixed point for ${name}`, () => {
      // Given
      const redactor = createRedactor("telemetry", { values: ["s3cr3tvalue"] });
      // When
      const output = redactor.redactString(input);
      // Then
      expect(redactor.redactString(output)).toBe(output);
    });
  }

  for (const input of [signedUrlCases[0].input, "token=x", "password=x", "?api_key=x&n=1"]) {
    test(`transcript masking does not manufacture closing brackets for ${input}`, () => {
      // Given
      const redactor = createRedactor("transcript");
      // When
      const output = redactor.redactString(input);
      // Then
      expect(output).toContain("[redacted]");
      expect(output).not.toContain("[redacted]]");
      expect(redactor.redactString(output)).toBe(output);
    });
  }

  test("transcript masking preserves a legitimate closing bracket", () => {
    // Given
    const redactor = createRedactor("transcript");
    // When
    const output = redactor.redactString("Env=[A_PASSWORD=x]");
    // Then
    expect(output).toBe("Env=[A_PASSWORD=[redacted]]");
  });
});

describe("createRedactor surface", () => {
  test("REDACTED is the canonical [redacted] sentinel", () => {
    expect(REDACTED).toBe("[redacted]");
  });

  test("REDACTION_PROFILES lists the three published profiles", () => {
    expect(REDACTION_PROFILES).toEqual(["secrets", "telemetry", "transcript"]);
  });

  test("PATTERN_CLASSES exposes only the regex-expressible classes", () => {
    // The secret-name grammars are scanner-owned; the catalog keeps the classes
    // that really are one regex: URL userinfo, field-name tests, and the
    // normalization placeholders.
    expect(PATTERN_CLASSES.secretAssignment).toBeUndefined();
    expect(PATTERN_CLASSES.secretMember).toBeUndefined();
    expect(PATTERN_CLASSES.secretYamlKey).toBeUndefined();
    expect(PATTERN_CLASSES.bearerToken).toBeUndefined();
    expect(PATTERN_CLASSES.signedQueryParam).toBeUndefined();
    expect(PATTERN_CLASSES.urlUserinfo).toBeDefined();
    expect(PATTERN_CLASSES.secretKeyedField).toBeDefined();
    expect(PATTERN_CLASSES.uncPath).toBeDefined();
    expect(PATTERN_CLASSES.homeAlias).toBeDefined();
    expect(PATTERN_CLASSES.highEntropyToken).toBeDefined();
    expect(PATTERN_CLASSES.port).toBeDefined();
    expect(PATTERN_CLASSES.containerId).toBeDefined();
    expect(PATTERN_CLASSES.digest).toBeDefined();
    expect(PATTERN_CLASSES.providerId).toBeDefined();
    expect(PATTERN_CLASSES.root).toBeDefined();
    expect(PATTERN_CLASSES.urlUserinfo?.pattern).toBeInstanceOf(RegExp);
  });
});

describe("secrets profile (pattern layer)", () => {
  const r = createRedactor("secrets");

  test("masks env-style secret assignments (keyword embedded in an UPPER key)", () => {
    expect(r.redactString("PASSWORD=hunter2 ok")).toBe("PASSWORD=[redacted] ok");
    expect(r.redactString("TOKEN=abcd ok")).toBe("TOKEN=[redacted] ok");
    expect(r.redactString("API_KEY=abcd ok")).toBe("API_KEY=[redacted] ok");
    expect(r.redactString("MY_API_KEY=abcd1234")).toBe("MY_API_KEY=[redacted]");
    expect(r.redactString("DATABASE_PASSWORD=hunter2 ok")).toBe("DATABASE_PASSWORD=[redacted] ok");
  });

  test("masks env-style secret assignments with lower/mixed-case keys", () => {
    expect(r.redactString("token=super-secret ok")).toBe("token=[redacted] ok");
    expect(r.redactString("Api_Key=abc123 ok")).toBe("Api_Key=[redacted] ok");
    expect(r.redactString("password=hunter2 ok")).toBe("password=[redacted] ok");
    expect(r.redactString("MY_TOKEN_VALUE=x ok")).toBe("MY_TOKEN_VALUE=[redacted] ok");
  });

  test("does not rematch an already-redacted assignment sentinel", () => {
    expect(r.redactString("password=[redacted] rootPassword=[redacted]")).toBe(
      "password=[redacted] rootPassword=[redacted]",
    );
    const layered = createRedactor("secrets", { values: ["hunter2longvalue"] });
    expect(layered.redactString("DB_PASSWORD=hunter2longvalue")).toBe("DB_PASSWORD=[redacted]");
  });

  test("query-param assignments stay single-marker (owned by the signed-query class)", () => {
    expect(r.redactString("?access_token=SECRETVAL")).toBe("?access_token=[redacted]");
    expect(r.redactString("&api_key=abc")).toBe("&api_key=[redacted]");
  });

  test("masks URL userinfo credentials", () => {
    expect(r.redactString("https://user:pw@proxy:3128/x")).toBe("https://[redacted]@proxy:3128/x");
  });

  test("masks percent-encoded URL userinfo credentials", () => {
    const out = r.redactString(
      "/libpod/images/pull?reference=https%3A%2F%2Fuser%3As3cr3tPass%40registry.internal%2Fteam%2Fimg%3A1.0&pullProgress=true",
    );
    expect(out).not.toContain("s3cr3tPass");
    expect(out).toContain("https%3A%2F%2F[redacted]%40registry.internal");
  });

  test("masks Bearer tokens but keeps the scheme word", () => {
    expect(r.redactString("Authorization: Bearer xyz.tok-123")).toBe("Authorization: Bearer [redacted]");
  });

  test("masks signed query parameters by whole key component", () => {
    expect(r.redactString("https://cdn/x?access_token=SECRETVAL&z=1")).toBe(
      "https://cdn/x?access_token=[redacted]&z=1",
    );
    // A substring keyword in an innocuous param is not redacted.
    expect(r.redactString("https://cdn/x?design=blue")).toBe("https://cdn/x?design=blue");
  });

  test("classifies signed query keys with the broad field recognizer", () => {
    // Given the field vocabulary plus the signature words, under query keys.
    for (const key of ["auth", "authorization", "authtoken", "apiToken", "sig", "X-Amz-Signature", "api_key"])
      expect(r.redactString(`?${key}=hunter2`), key).toBe(`?${key}=[redacted]`);
    // Then an innocuous key whose text merely contains a signature word stays readable.
    for (const key of ["design", "sv", "sp", "page"])
      expect(r.redactString(`?${key}=blue`), key).toBe(`?${key}=blue`);
  });

  test("leaves ordinary text untouched", () => {
    expect(r.redactString("nothing sensitive here")).toBe("nothing sensitive here");
  });
});

describe("value layer applied before pattern layer", () => {
  test("bounded composition masks a trailing known-value prefix before truncation", () => {
    // Given
    const redactor = createRedactor("secrets", { values: ["private-credential"] });
    const input = `private${LOG_LINE_TRUNCATED_MARKER}`;
    const expected = `[redacted]${LOG_LINE_TRUNCATED_MARKER}`;
    // When
    const output = redactor.redactString(input);
    const bounded = redactor.redactStringBounded?.(input, 1_024);
    // Then
    expect(output).toBe(expected);
    expect(bounded).toBe(expected);
  });

  test("a registered secret split across a pattern boundary never survives", () => {
    const r = createRedactor("secrets", { values: ["pa:ss@wo.rd"] });
    const out = r.redactString("https://pa:ss@wo.rd/path");
    expect(out).not.toContain("pa:ss");
    expect(out).not.toContain("wo.rd");
    expect(out).toContain("[redacted]");
  });

  test("value layer masks known values inside otherwise-innocuous text", () => {
    const r = createRedactor("secrets", { values: ["topSecretValue"] });
    expect(r.redactString("the value is topSecretValue here")).toBe("the value is [redacted] here");
  });

  test("longest-first so overlapping secrets do not leak a tail", () => {
    const r = createRedactor("secrets", { values: ["secret", "secret-token"] });
    expect(r.redactString("x secret-token y")).toBe("x [redacted] y");
  });

  test("bounded redaction aborts one-character secret expansion while constructing output", () => {
    // Given
    const r = createRedactor("secrets", { values: ["a"] });

    // When
    const result = r.redactStringBounded?.("a".repeat(900_000), 8 * 1_024 * 1_024);

    // Then
    expect(result).toBeUndefined();
  });

  test("bounded redaction accepts ordinary strings up to their actual byte budget", () => {
    // Given
    const r = createRedactor("secrets", { values: ["absent"] });
    const input = "x".repeat(64 * 1_024);

    // When
    const result = r.redactStringBounded?.(input, input.length);

    // Then
    expect(result).toBe(input);
  });

  test("bounded redaction preserves literal and secrets-pattern semantics", () => {
    // Given
    const r = createRedactor("secrets", { values: ["known-value"] });
    const input = "known-value PASSWORD=hunter2 https://user:pw@proxy Authorization: Bearer abc ?api_key=xyz";

    // When
    const result = r.redactStringBounded?.(input, 1_024);

    // Then
    expect(result).toBe(r.redactString(input));
  });
});

describe("bounded pattern replacers", () => {
  test("receive the same arguments as String.prototype.replace", () => {
    // Given a replacer that records its whole argument list.
    const calls: ReadonlyArray<unknown>[] = [];
    const replace = (...args: unknown[]): string => {
      calls.push(args);
      return "[masked]";
    };
    const input = "a abc b abc";

    // When unbounded `String.replace` and the bounded path both run it.
    const expected = input.replace(/abc/gu, replace);
    const unboundedArgs = [...calls];
    calls.length = 0;
    const bounded = replacePatternsBounded(input, [{ pattern: /abc/gu, replace }], 4_096);

    // Then both mask the same text and pass `(match, offset, input)` in that order.
    expect(bounded).toBe(expected);
    expect(calls).toEqual(unboundedArgs);
    expect(calls[0]?.[1]).toBe(2);
  });
});

describe("redactValue structure preservation", () => {
  const r = createRedactor("secrets");

  test("masks secretKeyedField keys without recursing into the value", () => {
    const v = r.redactValue({ password: "hunter2", nested: { token: "t" }, ok: "fine" }) as Record<
      string,
      unknown
    >;
    expect(v.password).toBe("[redacted]");
    expect((v.nested as Record<string, unknown>).token).toBe("[redacted]");
    expect(v.ok).toBe("fine");
  });

  test("keeps boolean capability metadata under secret-named keys while masking credentials", () => {
    const value = r.redactValue({
      buildSecrets: true,
      canReadSecrets: false,
      password: "hunter2",
      secret: { nested: "credential" },
      token: 123456,
    }) as Record<string, unknown>;
    expect(value.buildSecrets).toBe(true);
    expect(value.canReadSecrets).toBe(false);
    expect(value.password).toBe("[redacted]");
    expect(value.secret).toBe("[redacted]");
    expect(value.token).toBe("[redacted]");
  });

  test("preserves array shape and pattern-redacts string leaves", () => {
    const v = r.redactValue({ list: [1, "MY_API_KEY=zz1", true] }) as Record<string, unknown>;
    const list = v.list as unknown[];
    expect(list[0]).toBe(1);
    expect(list[1]).toBe("MY_API_KEY=[redacted]");
    expect(list[2]).toBe(true);
  });

  test("maps Error to a redacted name/message pair", () => {
    const v = r.redactValue(new Error("MY_TOKEN=abc")) as { name: string; message: string };
    expect(v).toMatchObject({ name: "Error", message: "MY_TOKEN=[redacted]" });
  });

  test("never throws on cyclic input", () => {
    const cyc: Record<string, unknown> = { password: "hunter2" };
    cyc.self = cyc;
    expect(() => r.redactValue(cyc)).not.toThrow();
    const out = r.redactValue(cyc) as Record<string, unknown>;
    expect(out.password).toBe("[redacted]");
    expect(out.self).toBe("[circular]");
  });

  test("redacts shared acyclic object references as repeated structures, not [circular]", () => {
    const shared = { ok: "fine", password: "hunter2" };
    const out = r.redactValue({ a: shared, b: shared, list: [shared, shared] }) as Record<string, unknown>;
    const expected = { ok: "fine", password: "[redacted]" };
    expect(out.a).toEqual(expected);
    expect(out.b).toEqual(expected);
    expect(out.list).toEqual([expected, expected]);
    expect(JSON.stringify(out)).not.toContain("[circular]");
  });

  test("never throws on exotic objects", () => {
    const throwingProxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("ownKeys boom");
        },
      },
    );
    expect(() => r.redactValue(throwingProxy)).not.toThrow();
    expect(r.redactValue(throwingProxy)).toBe("[redacted]");
  });

  test("fails closed when a root array element or a root error field throws", () => {
    // Given a root array with a throwing element getter.
    const list = [1, 2, 3];
    Object.defineProperty(list, 1, {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("element boom");
      },
    });
    // When / Then the element fails closed and the redactor never throws.
    expect(() => r.redactValue(list)).not.toThrow();
    expect(r.redactValue(list)).toEqual([1, "[redacted]", 3]);
    // And a root error whose message or name getter throws.
    const messageError = new Error("hidden");
    Object.defineProperty(messageError, "message", {
      configurable: true,
      get() {
        throw new Error("message boom");
      },
    });
    expect(() => r.redactValue(messageError)).not.toThrow();
    expect(r.redactValue(messageError)).toEqual({ name: "Error", message: "[redacted]" });
    const nameError = new Error("plain");
    Object.defineProperty(nameError, "name", {
      configurable: true,
      get() {
        throw new Error("name boom");
      },
    });
    expect(() => r.redactValue(nameError)).not.toThrow();
    expect(r.redactValue(nameError)).toEqual({ name: "[redacted]", message: "plain" });
  });

  test("redacts throwing object properties without leaking sibling values", () => {
    const value = {
      safe: "ok",
      get unstable() {
        throw new Error("getter boom");
      },
    };
    const out = r.redactValue(value) as Record<string, unknown>;
    expect(out.safe).toBe("ok");
    expect(out.unstable).toBe("[redacted]");
  });

  test("passes through null/undefined/number/bool unchanged", () => {
    expect(r.redactValue(null)).toBe(null);
    expect(r.redactValue(undefined)).toBe(undefined);
    expect(r.redactValue(42)).toBe(42);
    expect(r.redactValue(false)).toBe(false);
  });
});

describe("telemetry profile placeholders", () => {
  const t = createRedactor("telemetry");

  test("normalizes url/path/id/email to placeholders", () => {
    expect(t.redactString("see https://api.example.com/v1 done")).toBe("see [url] done");
    expect(t.redactString("at /home/alice/app done")).toBe("at [path] done");
    expect(t.redactString("id 12345678-1234-1234-1234-123456789abc done")).toBe("id [id] done");
    expect(t.redactString("mail alice@example.co done")).toBe("mail [email] done");
  });

  test("collapses a bare hostname to [host] after urls/emails removed", () => {
    expect(t.redactString("host api.example.com here")).toBe("host [host] here");
  });

  test("redacts a high-entropy token only when it has a letter and a digit", () => {
    expect(t.redactString("tok abcd1234efgh5678ijkl9012mnop done")).toBe("tok [redacted] done");
    // all-letters long run is not a token
    expect(t.redactString("word abcdefghijklmnopqrstuvwxyzabc done")).toBe(
      "word abcdefghijklmnopqrstuvwxyzabc done",
    );
  });

  test("applies secrets-profile string passes (signed query params, URL userinfo)", () => {
    expect(t.redactString("https://cdn/x?access_token=SECRETVAL&z=1")).toBe("[url]");
    expect(t.redactString("?access_token=SECRETVAL")).toBe("?access_token=[redacted]");
    expect(t.redactString("https://user:pw@proxy:3128/x")).toBe("[url]");
  });
});

describe("transcript profile placeholders", () => {
  test("every transcript assignment grammar keeps a complete reference", () => {
    const tr = createRedactor("transcript");
    for (const input of ["token=$A", "password $A", "-t=$A", "-t $A", 'token="$A"'])
      expect(tr.redactString(input), input).toBe(input);
    for (const input of ["token=$A.b", "password $A.b", "-t=$A.b", "-t $A.b"])
      expect(tr.redactString(input), input).toContain(REDACTED);
  });

  test("masks env home root to <HOME> when env supplied", () => {
    const tr = createRedactor("transcript", { env: { home: "/home/alice" } });
    expect(tr.redactString("/home/alice/app")).toContain("<HOME>");
  });

  test("masks ephemeral ports to <PORT> but keeps well-known ports", () => {
    const tr = createRedactor("transcript");
    expect(tr.redactString("listening on :54321")).toContain("<PORT>");
    expect(tr.redactString("https on :443")).toContain(":443");
  });

  test("masks container ids and sha256 digests", () => {
    const tr = createRedactor("transcript");
    expect(tr.redactString("container abc123def456")).toContain("<CONTAINER_ID>");
    expect(tr.redactString(`image sha256:${"a".repeat(64)}`)).toContain("sha256:<DIGEST>");
  });

  test("masks provider-style ids to <PROVIDER_ID>", () => {
    const tr = createRedactor("transcript");
    expect(tr.redactString("svc myapp_web_main")).toContain("<PROVIDER_ID>");
  });

  test("masks generic path roots with no env supplied", () => {
    const tr = createRedactor("transcript");
    expect(tr.redactString("/Users/bob/x")).toContain("<HOME>");
  });

  test("masks env user and host literals when supplied", () => {
    const tr = createRedactor("transcript", { env: { user: "alice", host: "devbox" } });
    expect(tr.redactString("user alice on devbox")).toBe("user <USER> on <HOST>");
  });
});

describe("complete env-reference exemption (all profiles)", () => {
  const profiles = ["secrets", "telemetry", "transcript"] as const;
  // Every value here is one complete environment-variable reference in a form
  // Lando documents, so the pattern layer must leave the whole line untouched.
  const completeCases = [
    "//npm.example.com/:_authToken=${NPM_TOKEN}",
    "password=${NPM_TOKEN?}",
    "?api_token=${NPM_TOKEN}",
    "API_KEY=${CI_TOKEN?}",
    "npm publish --token=$NPM_TOKEN",
    'npm publish --token="$NPM_TOKEN"',
    'export PASSWORD="$DB_PASSWORD"',
    "npm publish --token=$${NPM_TOKEN}",
    "token=$${NPM_TOKEN?}",
    "token=$A}",
    "{token=$A}",
    "token=$A next=1",
    'token=\\"$NPM_TOKEN\\"',
    'token=\\\\"$NPM_TOKEN\\\\"',
    // The lowered binding landofile/src/tooling-shell-binding.ts writes.
    '--token="$LANDO_BOUND_SECRET_ab12"""',
  ] as const;
  // Forms that name an environment variable but are not exactly one reference,
  // or are not terminated by a stop character of their grammar.
  const maskedCases = [
    { input: "token=${NPM_TOKEN}suffix", note: "suffix" },
    { input: "token=${NPM_TO", note: "truncated-open" },
    { input: "token=$${NPM_TOKEN", note: "truncated-doubled" },
    { input: "token=$${NPM_TOKEN}x", note: "suffixed-doubled" },
    { input: "token=${NPM_TOKEN}x", note: "suffixed-braced" },
    { input: "token=$NPM_TOKEN.b", note: "suffixed-bare" },
    { input: 'token="$NPM_TOKEN"suffix', note: "suffixed-quoted" },
    { input: "token='${NPM_TOKEN}'", note: "single-quoted" },
    { input: "token='$NPM_TOKEN'", note: "single-quoted-bare" },
    { input: "token=\\${NPM_TOKEN}", note: "escaped" },
    { input: "token=\\$NPM_TOKEN", note: "escaped-bare" },
    { input: 'token=\\"$NPM_TOKEN"', note: "unequal-backslashes" },
    { input: "token=${not a valid}", note: "malformed" },
    { input: "token=${BAD-NAME}", note: "malformed-identifier" },
    { input: "token=$1", note: "positional" },
    { input: "password=hunter2", note: "literal-secret" },
    { input: "?token=abc", note: "query-literal" },
  ] as const;

  for (const profile of profiles) {
    test(`${profile} leaves every complete environment reference intact`, () => {
      const redactor = createRedactor(profile);
      for (const input of completeCases) {
        const output = redactor.redactString(input);
        expect(output).not.toContain(REDACTED);
        expect(output).toBe(
          input.includes("npm.example.com") && profile === "telemetry"
            ? input.replace("npm.example.com", "[host]")
            : input,
        );
        expect(redactor.redactStringBounded?.(input, 4_096) ?? output).toBe(output);
      }
    });

    test(`${profile} masks every suffix, quote, escape, and malformed body`, () => {
      const redactor = createRedactor(profile);
      for (const { input, note } of maskedCases) {
        const output = redactor.redactString(input);
        expect(output, note).toContain(REDACTED);
        // Never a partial token such as `[redacted]}`.
        expect(output, note).not.toContain(`${REDACTED}}`);
        if (note.startsWith("suffix")) expect(output, note).not.toMatch(/\$\$?\{?[A-Za-z_]/u);
      }
    });

    test(`${profile} keeps registered values authoritative over references`, () => {
      const redactor = createRedactor(profile, {
        values: ["s3cr3t-token-value", "auth-authority-token"],
        authoritativeValues: ["auth-authority-token"],
      });
      const mixed = "token=s3cr3t-token-value _authToken=${NPM_TOKEN} pin=auth-authority-token";
      const output = redactor.redactString(mixed);
      expect(output).toContain("_authToken=${NPM_TOKEN}");
      expect(output).not.toContain("s3cr3t-token-value");
      expect(output).not.toContain("auth-authority-token");
      expect(output).toContain(REDACTED);
    });

    test(`${profile} masks a registered value that is the whole reference or part of it`, () => {
      const whole = createRedactor(profile, { values: ["$DB_PASSWORD"] });
      expect(whole.redactString('export PASSWORD="$DB_PASSWORD"')).not.toContain("DB_PASSWORD");
      const partial = createRedactor(profile, { values: ["DB_PASSWORD"] });
      expect(partial.redactString('export PASSWORD="$DB_PASSWORD"')).not.toContain("DB_PASSWORD");
      expect(partial.redactString("?token=$DB_PASSWORD")).not.toContain("DB_PASSWORD");
    });
  }

  test("a value the value layer masked mid-value is replaced whole without a stray bracket", () => {
    // Given a registered name that the value layer masks inside each value.
    const redactor = createRedactor("secrets", { values: ["DB_PASSWORD"] });

    // When / Then each value collapses to one sentinel and the next parameter survives.
    expect(redactor.redactString("token=$DB_PASSWORD next")).toBe("token=[redacted] next");
    expect(redactor.redactString("?token=$DB_PASSWORD&a=1")).toBe("?token=[redacted]&a=1");
    expect(redactor.redactString("password=preDB_PASSWORDpost")).toBe("password=[redacted]");
    // A braced reference still matches through its closing brace.
    expect(redactor.redactString("?sig=${DB_PASSWORD}")).toBe("?sig=[redacted]");
  });

  test("the lowered secret bindings stay readable", () => {
    // landofile/src/tooling-shell-binding.ts writes a quoted `"$NAME"` word plus
    // trailing empty quotes so an empty secret still reaches argv as one word.
    const name = "LANDO_BOUND_SECRET_0123456789abcdef";
    const redactor = createRedactor("secrets");
    expect(redactor.redactString(`--token="$${name}"""`)).toBe(`--token="$${name}"""`);
    // A shell-escaped copy of that word.
    expect(redactor.redactString(`--token=\\"$${name}\\"`)).toBe(`--token=\\"$${name}\\"`);
    // The single-quoted insertion is a single-quoted value, so it stays masked.
    expect(redactor.redactString(`--token='"$${name}"'`)).toContain(REDACTED);
  });

  test("a stop character of each grammar verifies the terminator", () => {
    // The assignment grammar ends a value at a comma or semicolon; the query
    // grammar ends it at `&`, which must stay available to the next parameter.
    expect(createRedactor("secrets").redactString("token=$A,next=1")).toBe("token=$A,next=1");
    expect(createRedactor("secrets").redactString("token=$A;")).toBe("token=$A;");
    expect(createRedactor("secrets").redactString("?token=$A&next=1")).toBe("?token=$A&next=1");
    expect(createRedactor("transcript").redactString("?token=$A&next=1")).toBe("?token=$A&next=1");
    // Outside its own stop class the terminator is unverified, so the value stays masked.
    expect(createRedactor("transcript").redactString("token=$A,next=1")).toContain(REDACTED);
  });

  test("truncation of an incomplete reference stays masked on the secrets path", () => {
    const redactor = createRedactor("secrets");
    const input = `token=\${NPM_TOK${LOG_LINE_TRUNCATED_MARKER}`;
    const output = redactor.redactString(input);
    expect(output).toContain(REDACTED);
    expect(output).toContain(LOG_LINE_TRUNCATED_MARKER);
    expect(output).not.toContain("NPM_TOK");
  });
});

describe("assignment grammar forms (#2399)", () => {
  const r = createRedactor("secrets");
  // Every accepted spelling and its exact masking. The colon forms keep a quoted
  // value's own quoting (and escaped-JSON backslash run) around the sentinel.
  const masked = [
    { input: 'password= "x"', expected: "password= [redacted]" },
    { input: 'password = "x"', expected: "password = [redacted]" },
    { input: 'password: "x"', expected: 'password: "[redacted]"' },
    { input: '{"password":"x"}', expected: '{"password":"[redacted]"}' },
    { input: '{"password" : "x"}', expected: '{"password" : "[redacted]"}' },
    { input: "{'password': 'x'}", expected: "{'password': '[redacted]'}" },
    { input: '{\\"password\\":\\"x\\"}', expected: '{\\"password\\":\\"[redacted]\\"}' },
    { input: '{"token": 12345}', expected: '{"token": "[redacted]"}' },
    { input: '{\\"token\\": 12345}', expected: '{\\"token\\": \\"[redacted]\\"}' },
    { input: '{"password":"left\\"right"}', expected: '{"password":"[redacted]"}' },
    { input: "  db_password: s3cret value", expected: "  db_password: [redacted]" },
    { input: "- api_key: abc", expected: "- api_key: [redacted]" },
    { input: "db_password: s3cret", expected: "db_password: [redacted]" },
    { input: "Token: expired", expected: "Token: [redacted]" },
    { input: "PASSWORD=true", expected: "PASSWORD=[redacted]" },
    // A whole-name secret that is not a strong substring.
    { input: "auth=hunter2", expected: "auth=[redacted]" },
    { input: "authorization=hunter2", expected: "authorization=[redacted]" },
    { input: '{"authorization":"hunter2"}', expected: '{"authorization":"[redacted]"}' },
    // A secret reference is kept only when it is the whole value.
    { input: 'token: "prefix ${secret:EXISTING}"', expected: 'token: "[redacted]"' },
    { input: 'token="${secret:EXISTING}"suffix', expected: "token=[redacted]" },
    // A quoted shell word carries its non-stop suffix as one value.
    { input: 'password="x"suffix', expected: "password=[redacted]" },
    { input: 'password="x"/dev/null', expected: "password=[redacted]" },
  ] as const;

  const unchanged = [
    "The password is required",
    "Failed to read token: file not found",
    "SecretNotFoundError: missing DB_PASSWORD",
    "secretRedaction: true",
    '{"secretRedaction":true}',
    "Enter password: ",
    "password:",
    "password:\n",
    "cacheKey: value",
    "oauth=hunter2",
  ] as const;

  for (const { input, expected } of masked) {
    test(`masks ${JSON.stringify(input)}`, () => {
      const output = r.redactString(input);
      expect(output).toBe(expected);
      expect(r.redactString(output)).toBe(expected);
      expect(r.redactStringBounded?.(input, 4_096)).toBe(expected);
    });
  }

  for (const input of unchanged) {
    test(`leaves ${JSON.stringify(input)} unchanged`, () => {
      expect(r.redactString(input)).toBe(input);
      expect(r.redactStringBounded?.(input, 4_096)).toBe(input);
    });
  }

  test("keeps a bare typed literal as a boolean or null, never as a string", () => {
    // Given the member and YAML forms, whose syntax types a bare scalar.
    for (const input of ['{"password":true}', '{"password":false}', '{"password":null}', "password: ~"])
      expect(r.redactString(input), input).toBe(input);
    for (const input of ["password: TRUE", "password: FALSE", "password: NULL"])
      expect(r.redactString(input), input).toBe(input);
    // `~` is YAML spelling only: a JSON or Python member keeps the string meaning.
    expect(r.redactString('{"password": ~}')).toBe('{"password": "[redacted]"}');
    expect(r.redactString("{'password': ~}")).toBe("{'password': '[redacted]'}");
  });

  test("splits the broad field recognizer from the structural colon recognizer", () => {
    // Given a name that contains a secret word but whose last segment is not sensitive.
    // `=` and member forms use the broad field test; colon forms use the structural one,
    // because a false positive there would swallow a diagnostic or a capability flag.
    expect(r.redactString('apassword = "x"')).toBe("apassword = [redacted]");
    expect(r.redactString('{"apassword":"x"}')).toBe('{"apassword":"[redacted]"}');
    expect(r.redactString('apassword: "x"')).toBe('apassword: "x"');
  });

  test.each([
    "password",
    "dbPassword",
    "APIPassword",
    "apiPassword",
    "APIKey",
    "APIKeys",
    "apiKey",
    "secretAccessKey",
    "authToken",
    "AUTHToken",
    "DBPassword",
    "rootPassword",
    "cacheKey",
    "certs.key",
    "tokenFile",
    "APITokenizer",
    "APIKeyFile",
    "PGPASSWORD",
    "defaultSecretStore",
    "apassword",
  ])("colon grammar agrees with the structural recognizer for %s", (name) => {
    // Given / When the colon form masks exactly when the recognizer accepts the name.
    const masked = r.redactString(`${name}: "x"`) === `${name}: "[redacted]"`;
    // Then the grammar and the recognizer never disagree.
    expect(masked).toBe(isSecretStructuralName(name));
  });

  test.each([
    "auth",
    "authorization",
    "authtoken",
    "oauth",
    "apassword",
    "tokenizer",
    "db_password",
    "api-token",
  ])("equals and member grammars agree with the field recognizer for %s", (name) => {
    // Given / When both broad-name forms mask exactly when the recognizer accepts.
    const equalsMasked = r.redactString(`${name}=hunter2`).includes(REDACTED);
    const memberMasked = r.redactString(`{"${name}":"hunter2"}`).includes(REDACTED);
    // Then the shared whole-name source keeps all three in agreement.
    expect(equalsMasked).toBe(isSecretFieldName(name));
    expect(memberMasked).toBe(isSecretFieldName(name));
  });

  test("consumes a shell word's non-stop suffix as part of a quoted value", () => {
    // Given a quoted value and a suffix the grammar does not stop on, all one word.
    for (const input of ['password="x"suffix', 'password="x"/dev/null', "password='x'y"])
      expect(r.redactString(input), input).toBe("password=[redacted]");
    // Then a stop character still ends the word after the masked value.
    expect(r.redactString('password="x" suffix')).toBe("password=[redacted] suffix");
    expect(r.redactString('password="x", next')).toBe("password=[redacted], next");
  });

  test("treats an inserted sentinel in the shell-word suffix as one opaque unit", () => {
    // Given a registered value the value layer masks inside a quoted word's suffix.
    const known = createRedactor("secrets", { values: ["KNOWN"] });
    // When / Then the whole shell word is one value, even across the sentinel.
    for (const [input, expected] of [
      ['password="a"leftKNOWNright', "password=[redacted]"],
      ['?token="a"leftKNOWNright&keep=yes', "?token=[redacted]&keep=yes"],
    ] as const) {
      expect(known.redactString(input), input).toBe(expected);
      expect(known.redactPrefix(input), input).toBe(expected);
      expect(known.redactStringBounded?.(input, 4_096), input).toBe(expected);
    }
  });

  test("keeps a complete env reference and published default in every new form", () => {
    for (const input of [
      'password= "$TOKEN"',
      'password: "$TOKEN"',
      '{"password":"$TOKEN"}',
      'db_password: "$TOKEN"',
      "db_password: $TOKEN",
      'TOKEN: "${secret:EXISTING}"',
      "token: ${secret:EXISTING}",
      "token=$${secret:EXISTING}",
      '{"token":"${secret:store://bucket/path?version=latest}"}',
    ])
      expect(r.redactString(input), input).toBe(input);
    for (const input of ['{"password":"lando"}', "db_password: lando"])
      expect(r.redactString(input), input).toBe(input);
  });
});

describe("complete-text secret values (#2395)", () => {
  const r = createRedactor("secrets");

  test("closes an unterminated quoted value to the end of the input", () => {
    expect(r.redactString('password="hunter2')).toBe("password=[redacted]");
    expect(r.redactString("api_token='hunter2")).toBe("api_token=[redacted]");
    expect(r.redactString('password=\\"first')).toBe("password=[redacted]");
    expect(r.redactString('password="x\\"')).toBe("password=[redacted]");
    expect(r.redactString('password: "first')).toBe('password: "[redacted]"');
    expect(r.redactString('{"password":"first')).toBe('{"password":"[redacted]"');
  });

  test("appends nothing for a bearer introducer with no value", () => {
    expect(r.redactString("Authorization: Bearer")).toBe("Authorization: Bearer");
    expect(r.redactString("Authorization: Bearer ")).toBe("Authorization: Bearer ");
  });

  test("leaves an unterminated opener intact in prefix redaction", () => {
    for (const input of ['password="hunter2', "api_token='hunter2", 'password=\\"first', 'password: "first'])
      expect(r.redactPrefix(input), input).toBe(input);
  });

  test("a shell string whose closing quote follows the name still masks one value", () => {
    expect(r.redactString('RUN echo "token=" > f')).toBe('RUN echo "token=" > f');
    expect(r.redactString('RUN sh -c "mysql --password=secret"')).toBe(
      'RUN sh -c "mysql --password=[redacted]"',
    );
  });

  test("bounded redaction closes too and fails closed past its budget", () => {
    const input = 'password="hunter2';
    expect(r.redactStringBounded?.(input, 4_096)).toBe("password=[redacted]");
    expect(r.redactStringBounded?.(input, 10)).toBeUndefined();
  });
});

describe("redaction idempotence and bounded equivalence (R7)", () => {
  const forms = [
    'password= "x"',
    'password = "x"',
    'password: "x"',
    '{"password":"x"}',
    "{'password': 'x'}",
    '{\\"password\\":\\"x\\"}',
    '{"token": 12345}',
    "  db_password: s3cret value",
    "- api_key: abc",
    'password="left\\"right"',
    'a password="first\ncanary\nlast" b',
    'password="x"suffix',
    '?token="x"suffix',
  ] as const;

  test("secrets output is a fixed point, including a registered quoted sentinel", () => {
    // Given the sentinel itself registered with quotes, as a value layer would mask it.
    const r = createRedactor("secrets", { values: ['"[redacted]"'] });
    for (const input of [...forms, '{"password":"[redacted]"}', 'k="[redacted]"']) {
      const once = r.redactString(input);
      expect(r.redactString(once), input).toBe(once);
    }
  });

  test("bounded redaction masks exactly what unbounded redaction masks", () => {
    const r = createRedactor("secrets");
    for (const input of forms) {
      const expected = r.redactString(input);
      expect(r.redactStringBounded?.(input, 4_096), input).toBe(expected);
    }
  });
});

describe("assignment grammar stays linear on adversarial input (R6)", () => {
  const r = createRedactor("secrets");

  test("scans a repeated secret-word run once", () => {
    // Given a long run of secret words with no separator, the old name pattern
    // backtracked through every start position.
    const input = `${"token".repeat(20_000)}=x`;
    // When
    const started = performance.now();
    const output = r.redactString(input);
    // Then one pass completes far below the quadratic bound.
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(output.endsWith("[redacted]")).toBe(true);
  });

  test("never starts a match inside a long backslash run", () => {
    // Given a run far longer than any escaped opener, with no name before it.
    const input = `${"\\".repeat(200_000)}"x`;
    // When
    const started = performance.now();
    const output = r.redactString(input);
    // Then the member grammar only considers the run's start.
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(output).toBe(input);
  });

  test("scans a repeated encoded-scheme run once", () => {
    // Given a percent-encoded scheme followed by many encoded colons and no
    // encoded `@`: the lazy userinfo runs used to re-split the same run.
    const input = `https%3A%2F%2F${"x%3A".repeat(50_000)}`;
    // When
    const started = performance.now();
    const output = r.redactString(input);
    // Then one pass completes far below the quadratic bound and nothing is masked,
    // because there is no encoded `%40` to close a userinfo credential.
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(output).toBe(input);
  });

  test("scans a failing dotted scheme run once", () => {
    // Given a long run of scheme characters with no userinfo `@`: the greedy
    // scheme used to be retried at every word boundary inside the run.
    const input = `${"a.".repeat(60_000)}a://u:p`;
    // When
    const started = performance.now();
    const output = r.redactString(input);
    // Then one pass completes far below the quadratic bound and nothing is masked.
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(output).toBe(input);
  });

  test("scans a long separator run once", () => {
    // Given a colon followed by a very long whitespace run.
    const input = `password:${" ".repeat(200_000)}x`;
    // When
    const started = performance.now();
    const output = r.redactString(input);
    // Then the separator is consumed once.
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(output.endsWith("[redacted]")).toBe(true);
  });
});
