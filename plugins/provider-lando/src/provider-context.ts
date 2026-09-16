import type { ProviderErrorContext } from "@lando/container-runtime/engine-api";

export const LANDO_CTX: ProviderErrorContext = {
  providerId: "lando",
  remediation:
    "Run `lando doctor` to inspect the Lando runtime, then retry the failing command. Run `lando setup` if the runtime is not installed or healthy.",
};
