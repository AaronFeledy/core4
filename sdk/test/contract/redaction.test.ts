import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import { createRedactor } from "@lando/sdk/secrets";
import type { CreateRedactorOptions, RedactionProfile } from "@lando/sdk/secrets";
import { type RedactionContractHarness, SECRET_SOUP_FIXTURE, runRedactionContract } from "@lando/sdk/test";

const makeRedactor = (profile: RedactionProfile, options?: CreateRedactorOptions) =>
  createRedactor(profile, options);

/**
 * Hard-coded golden strings produced by running `createRedactor` against
 * `SECRET_SOUP_FIXTURE.text` with `registeredSecrets` and the canonical env.
 * These are the asserted truth for the contract suite.
 */
const GOLDEN_SECRETS =
  "DB_PASSWORD=[redacted]] https://[redacted]@host.example.com/path Authorization: Bearer [redacted] ?token=[redacted]&api_key=[redacted] /home/alice/projects/app C:\\Users\\alice\\AppData\\Local\\Temp\\x \\\\fileserver\\share\\secret ~/.config/lando/config.yml abc123def456 123e4567-e89b-12d3-a456-426614174000 sha256:aabbccddee112233445566778899aabbccddee112233445566778899aabbccdd [redacted] :54321 myapp_web_ab12cd34";

const GOLDEN_TELEMETRY =
  "DB_PASSWORD=[redacted]] [url] Authorization: Bearer [redacted] ?token=[redacted]&api_key=[redacted] [path] [path] [path] [path] abc123def456 [id] sha256:[redacted] [redacted] :54321 myapp_web_ab12cd34";

const GOLDEN_TRANSCRIPT =
  "DB_PASSWORD=[redacted] https://[redacted]@<HOST>/path Authorization: Bearer [redacted] ?token=[redacted]&api_key=[redacted] <HOME> <TMP> \\\\fileserver\\share\\secret [redacted] <CONTAINER_ID> 123e4567-e89b-12d3-a456-<CONTAINER_ID> sha256:<DIGEST> [redacted] :<PORT> <PROVIDER_ID>";

const harness: RedactionContractHarness = {
  name: "createRedactor",
  makeRedactor,
  golden: {
    secrets: { string: GOLDEN_SECRETS },
    telemetry: { string: GOLDEN_TELEMETRY },
    transcript: { string: GOLDEN_TRANSCRIPT },
  },
};

describe("runRedactionContract (createRedactor)", () => {
  test("satisfies the redaction contract", async () => {
    const exit = await Effect.runPromiseExit(runRedactionContract(harness));
    if (!Exit.isSuccess(exit)) {
      const failure = Exit.isFailure(exit) ? exit.cause : undefined;
      throw new Error(`Contract failed: ${JSON.stringify(failure)}`);
    }
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("golden strings contain [redacted] (lowercase), never [REDACTED]", () => {
    expect(GOLDEN_SECRETS).toContain("[redacted]");
    expect(GOLDEN_TELEMETRY).toContain("[redacted]");
    expect(GOLDEN_TRANSCRIPT).toContain("[redacted]");
    expect(GOLDEN_SECRETS).not.toContain("[REDACTED]");
    expect(GOLDEN_TELEMETRY).not.toContain("[REDACTED]");
    expect(GOLDEN_TRANSCRIPT).not.toContain("[REDACTED]");
  });

  test("SECRET_SOUP_FIXTURE is frozen", () => {
    expect(Object.isFrozen(SECRET_SOUP_FIXTURE)).toBe(true);
    expect(Object.isFrozen(SECRET_SOUP_FIXTURE.registeredSecrets)).toBe(true);
  });

  test("SECRET_SOUP_FIXTURE.registeredSecrets contains a prefix-pair", () => {
    const secrets = SECRET_SOUP_FIXTURE.registeredSecrets;
    const hasPrefixPair = secrets.some((s) => secrets.some((t) => t !== s && t.startsWith(s)));
    expect(hasPrefixPair).toBe(true);
  });
});
