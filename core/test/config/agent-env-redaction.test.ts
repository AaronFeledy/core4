import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { SecretNotFoundError } from "@lando/core/errors";
import { SecretStore } from "@lando/core/services";

import { AGENT_CONTEXT_ENV_ALLOWLIST, resolveAgentContextEnv } from "../../src/config/agent-env.ts";
import { RedactionService, RedactionServiceLive } from "../../src/redaction/service.ts";

const emptySecretStore = Layer.succeed(SecretStore, {
  id: "test",
  get: (secret: string) => Effect.fail(new SecretNotFoundError({ secret, message: `missing ${secret}` })),
  has: () => Effect.succeed(false),
  list: Effect.succeed([]),
});

const redactorForForwardedEnv = (sourceEnv: Record<string, string>) =>
  Effect.runPromise(
    Effect.flatMap(RedactionService, (service) => service.forProfile("secrets", { sourceEnv })).pipe(
      Effect.provide(RedactionServiceLive),
      Effect.provide(emptySecretStore),
    ),
  );

describe("agent-context env forwarding is redaction-aware", () => {
  test("a credential-shaped forwarded value is masked while identity markers stay visible", async () => {
    const forwarded = resolveAgentContextEnv(
      { CI: "true", CLAUDECODE: "1", AGENT_API_TOKEN: "tok-abcdef123456" },
      [...AGENT_CONTEXT_ENV_ALLOWLIST, "AGENT_API_TOKEN"],
    );
    expect(forwarded.AGENT_API_TOKEN).toBe("tok-abcdef123456");

    const redactor = await redactorForForwardedEnv(forwarded);
    const rendered = redactor.redactString(
      `CI=${forwarded.CI} CLAUDECODE=${forwarded.CLAUDECODE} TOKEN=${forwarded.AGENT_API_TOKEN}`,
    );

    expect(rendered).not.toContain("tok-abcdef123456");
    expect(rendered).toContain("CI=true");
    expect(rendered).toContain("CLAUDECODE=1");
  });

  test("the default identity-marker allowlist carries nothing a redactor treats as a secret", async () => {
    const forwarded = resolveAgentContextEnv({ CI: "true", OPENCODE: "1", CLAUDECODE: "1", AGENT: "codex" });

    const redactor = await redactorForForwardedEnv(forwarded);
    const rendered = redactor.redactString("CI=true OPENCODE=1 CLAUDECODE=1 AGENT=codex");

    expect(rendered).toBe("CI=true OPENCODE=1 CLAUDECODE=1 AGENT=codex");
  });
});
