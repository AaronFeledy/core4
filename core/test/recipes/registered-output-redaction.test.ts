import { afterEach, expect, test } from "bun:test";
import { registerRedactionValues, resetRegisteredRedactionValuesForTesting } from "@lando/redaction/service";
import { Effect } from "effect";
import { buildOomDoctorCheck } from "../../src/cli/commands/doctor-oom.ts";
import { loadLando3TranslatorPorts } from "../../src/recipes/lando3-ports.ts";
import { redactBunOutput } from "../../src/recipes/post-init/runtime.ts";

afterEach(resetRegisteredRedactionValuesForTesting);

test("post-init output masks a value registered after module loading", async () => {
  // Given
  const secret = "post-init-registered-canary";
  await Effect.runPromise(registerRedactionValues([secret]));
  // When
  const output = redactBunOutput(`command failed with ${secret}`);
  // Then
  expect(output).toBe("command failed with [redacted]");
});

test("OOM diagnostics mask registered correlation values", async () => {
  // Given
  const secret = "oom-registered-canary";
  await Effect.runPromise(registerRedactionValues([secret]));
  // When
  const check = buildOomDoctorCheck(
    { kind: "oom", correlation: { app: secret } },
    {
      provider: { id: "lando", displayName: "Lando", version: "0.0.0" },
      providerKind: "managed",
      platform: "linux",
    },
  );
  // Then
  expect(check?.context?.app).toBe("[redacted]");
});

test("bundled Lando 3 translator ports observe later secret registration", async () => {
  // Given
  const ports = await loadLando3TranslatorPorts();
  const secret = "lando3-registered-canary";
  await Effect.runPromise(registerRedactionValues([secret]));
  // When
  const output = ports.redactor.redactString(`translation failed with ${secret}`);
  // Then
  expect(output).toBe("translation failed with [redacted]");
});
