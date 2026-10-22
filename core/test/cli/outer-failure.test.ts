import { expect, test } from "bun:test";
import { registerRedactionValues } from "@lando/redaction/service";
import { Effect } from "effect";
import { safeOuterFailure } from "../../src/cli/outer-failure.ts";

test("outer failures redact registered values and secret patterns", async () => {
  const secret = "outer-catch-registered-value";
  await Effect.runPromise(registerRedactionValues([secret]));
  const output = await safeOuterFailure(new Error(`${secret} https://user:private-password@example.com`));
  expect(output).not.toContain(secret);
  expect(output).not.toContain("private-password");
  expect(output).toContain("[redacted]");
});

test("outer failures fail closed when redactor import fails", async () => {
  const output = await safeOuterFailure(new Error("raw-credential"), async () => {
    throw new Error("import-credential");
  });
  expect(output).not.toContain("credential");
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
