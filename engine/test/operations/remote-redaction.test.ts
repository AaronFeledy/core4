import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRedactionValues, resetRegisteredRedactionValuesForTesting } from "@lando/redaction/service";
import { Effect } from "effect";
import { appRemoteAdd } from "../../src/operations/remote.ts";

afterEach(resetRegisteredRedactionValuesForTesting);

test("remote results mask registered values under non-secret config keys", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-remote-redaction-"));
  const secret = "remote-registered-canary";
  try {
    await Bun.write(join(root, ".lando.yml"), "name: redaction\nruntime: 4\nservices: {}\n");
    await Effect.runPromise(registerRedactionValues([secret]));
    // When
    const result = await Effect.runPromise(
      appRemoteAdd({ cwd: root, name: "dev", config: { source: "test", endpoint: secret } }),
    );
    // Then
    expect(result.config.endpoint).toBe("[redacted]");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
