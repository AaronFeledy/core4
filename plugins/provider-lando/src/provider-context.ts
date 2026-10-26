import type { ProviderErrorContext } from "@lando/container-runtime/engine-api";
import { composeAdaptersFor } from "@lando/container-runtime/provider-assembly";
import { standaloneSecretsRedactor } from "@lando/container-runtime/redact";

export const LANDO_CTX_BASE = {
  providerId: "lando",
  remediation:
    "Run `lando doctor` to inspect the Lando runtime, then retry the failing command. Run `lando setup` if the runtime is not installed or healthy.",
} as const;

export const LANDO_CTX: ProviderErrorContext = { ...LANDO_CTX_BASE, env: {} };

export const providerContextForEnv = (env: ProviderErrorContext["env"]): ProviderErrorContext => ({
  ...LANDO_CTX_BASE,
  env,
  redactor: standaloneSecretsRedactor(env),
});

export const { renderCompose, emitCompose, composePath } = composeAdaptersFor(LANDO_CTX);
