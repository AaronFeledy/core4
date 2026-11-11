import { describe, expect, test } from "bun:test";

import { REDACTED, createRedactor } from "@lando/sdk/secrets";

describe("deep-key masking keeps only exact published defaults", () => {
  test.each([{ password: "lando" }, { rootPassword: "landolando" }, { MSSQL_SA_PASSWORD: "Landolando1" }])(
    "keeps %j",
    (value) => {
      // When
      const output = createRedactor("secrets").redactValue(value);
      // Then
      expect(output).toEqual(value);
    },
  );

  test.each([
    { password: "Lando" },
    { password: " lando" },
    { password: "lando\n" },
    { password: "hunter2" },
    { password: 12345 },
    { password: { nested: "lando" } },
  ])("masks %j", (value) => {
    // When
    const output = createRedactor("secrets").redactValue(value);
    // Then
    expect(output).toEqual({ password: REDACTED });
  });

  test("masks a published default registered as an explicit value", () => {
    // Given
    const redactor = createRedactor("secrets", { values: ["lando"], authoritativeValues: ["lando"] });
    // When
    const output = redactor.redactValue({ password: "lando" });
    // Then
    expect(output).toEqual({ password: REDACTED });
  });

  test("masks a published default registered as a whole-token value", () => {
    // Given
    const redactor = createRedactor("secrets", { wholeTokenValues: ["lando"] });
    // When
    const output = redactor.redactValue({ password: "lando" });
    // Then
    expect(output).toEqual({ password: REDACTED });
  });

  test("masks a secret-named key whose getter throws", () => {
    // Given
    const value = {
      get password(): string {
        throw new Error("unreadable");
      },
    };
    // When
    const output = createRedactor("secrets").redactValue(value);
    // Then
    expect(output).toEqual({ password: REDACTED });
  });
});

describe("secret-assignment patterns keep only exact published defaults", () => {
  const redactor = createRedactor("secrets");

  test.each([
    "password=lando",
    "PGPASSWORD=lando",
    'password="lando"',
    "password='landolando'",
    "MSSQL_SA_PASSWORD=Landolando1",
    "user=lando password=lando",
  ])("keeps %s", (input) => {
    // When
    const output = redactor.redactString(input);
    // Then
    expect(output).toBe(input);
  });

  test.each(["password=lando2", "password=Lando", "password=hunter2"])("masks %s", (input) => {
    // When
    const output = redactor.redactString(input);
    // Then
    expect(output).toBe("password=[redacted]");
  });

  test("masks a published default registered as an explicit value", () => {
    // Given
    const registered = createRedactor("secrets", { values: ["lando"] });
    // When
    const output = registered.redactString("password=lando");
    // Then
    expect(output).toBe("password=[redacted]");
  });

  test("masks a published default registered as a whole-token value", () => {
    // Given
    const registered = createRedactor("secrets", { wholeTokenValues: ["lando"] });
    // When
    const output = registered.redactString("password=lando");
    // Then
    expect(output).toBe("password=[redacted]");
  });

  test("leaves other pattern classes unchanged for published default bytes", () => {
    // When
    const output = redactor.redactString("mysql://lando:lando@db:3306/app");
    // Then
    expect(output).toBe("mysql://[redacted]@db:3306/app");
  });
});
