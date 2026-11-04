import { expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { safeOuterFailure } from "../../src/cli/outer-failure.ts";

test("outer failures redact registered values and secret patterns", async () => {
  const secret = "outer-catch-registered-value";
  const output = await safeOuterFailure(
    new Error(`${secret} https://user:private-password@example.com`),
    async () => ({
      ...(await import("@lando/redaction/service")),
      createStandaloneRedactor: () => createStandaloneRedactor("secrets", { authoritativeTokens: [secret] }),
    }),
  );
  expect(output).not.toContain(secret);
  expect(output).not.toContain("private-password");
  expect(output).toContain("[redacted]");
});

test("outer failures return the constant when the redactor cannot load", async () => {
  const output = await safeOuterFailure(new Error("module load failed"), async () => {
    throw new Error("import-detail");
  });
  expect(output).toBe("Lando failed. Failure details could not be safely redacted.");
  expect(output).not.toContain("import-detail");
  expect(output).not.toContain("module load failed");
});

test("outer failures fail closed when the loaded redactor throws", async () => {
  const output = await safeOuterFailure(new Error("raw-credential"), async () => ({
    ...(await import("@lando/redaction/service")),
    createStandaloneRedactor: () => {
      throw new Error("redactor-broke");
    },
  }));
  expect(output).toBe("Lando failed. Failure details could not be safely redacted.");
});

test("outer failures fail closed when error conversion throws", async () => {
  const output = await safeOuterFailure({
    toString: () => {
      throw new Error("conversion-credential");
    },
  });
  expect(output).toBe("Lando failed. Failure details could not be safely redacted.");
});
