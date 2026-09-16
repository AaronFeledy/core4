import { collectSecretEnvValues } from "@lando/redaction/service";

const collectConfigValues = (result: unknown): string[] => {
  if (typeof result !== "object" || result === null) return [];
  const tokens: string[] = [];
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "string") tokens.push(...collectSecretEnvValues({ [key]: value }));
    else tokens.push(...collectConfigValues(value));
  }
  return tokens;
};

export const configRedactionTokens = (result: unknown): readonly string[] => {
  if (typeof result !== "object" || result === null) return [];
  const tokens = [
    ...collectConfigValues("config" in result ? result.config : undefined),
    ...collectConfigValues("value" in result ? result.value : undefined),
  ];
  // A set result carries a dot-path beside a scalar rather than its enclosing map.
  if (
    "key" in result &&
    typeof result.key === "string" &&
    "value" in result &&
    typeof result.value === "string"
  ) {
    const leaf = result.key.split(".").at(-1);
    if (leaf !== undefined) tokens.push(...collectSecretEnvValues({ [leaf]: result.value }));
  }
  return tokens;
};
