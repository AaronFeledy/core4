import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRedactionService } from "@lando/redaction/service";
import { RecipePostInitError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { buildOomDoctorCheck } from "../../src/cli/commands/doctor-oom.ts";
import { loadLando3TranslatorPorts } from "../../src/recipes/lando3-ports.ts";
import { runPostInit } from "../../src/recipes/post-init/runtime.ts";

test("post-init output masks a value registered after module loading", async () => {
  // Given
  const secret = "post-init-registered-canary";
  const service = makeRedactionService();
  const redactor = await Effect.runPromise(service.forProfile("secrets"));
  await Effect.runPromise(service.registerValues([secret]));
  // When
  const root = await mkdtemp(join(tmpdir(), "lando-post-init-redaction-"));
  let output = "";
  try {
    await writeFile(join(root, "package.json"), "{}");
    try {
      await runPostInit({
        runBun: async () => {
          throw new TypeError("Unexpected Bun action");
        },
        actions: [{ type: "command", cmd: "app:config:translate", args: [] }],
        destination: root,
        recipeId: "fixture",
        appName: "fixture",
        answers: {},
        redact: redactor.redactString,
        commandRunner: async () => ({ exitCode: 1, stdout: `command failed with ${secret}`, stderr: "" }),
      });
    } catch (error) {
      if (!(error instanceof RecipePostInitError)) throw error;
      output = error.remediation;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  // Then
  expect(output).toContain("command failed with [redacted]");
  expect(output).not.toContain(secret);
});

test("OOM diagnostics mask registered correlation values", async () => {
  // Given
  const secret = "oom-registered-canary";
  const envSecret = "oom-environment-canary";
  const service = makeRedactionService();
  await Effect.runPromise(service.registerValues([secret]));
  // When
  const check = buildOomDoctorCheck(
    { kind: "oom", correlation: { app: secret, containerName: envSecret } },
    {
      provider: { id: "lando", displayName: "Lando", version: "0.0.0" },
      providerKind: "managed",
      platform: "linux",
    },
    await Effect.runPromise(service.forProfile("secrets", { sourceEnv: { P5_OOM_SECRET: envSecret } })),
  );
  // Then
  expect(check?.context?.app).toBe("[redacted]");
  expect(check?.context?.containerName).toBe("[redacted]");
});

test("bundled Lando 3 translator ports observe later secret registration", async () => {
  // Given
  const service = makeRedactionService();
  const ports = await loadLando3TranslatorPorts(await Effect.runPromise(service.forProfile("secrets")));
  const secret = "lando3-registered-canary";
  await Effect.runPromise(service.registerValues([secret]));
  // When
  const output = ports.redactor.redactString(`translation failed with ${secret}`);
  // Then
  expect(output).toBe("translation failed with [redacted]");
});
