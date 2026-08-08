import { ComposeProjectFieldKey } from "@lando/sdk/schema";
import type { AppPlan, ProviderCapabilities } from "@lando/sdk/schema";

export type ComposeProjectFieldUse = {
  readonly key: ComposeProjectFieldKey;
};

type ComposeProjectFieldCapabilityView = Pick<ProviderCapabilities, "composeSpec" | "composeProjectFields">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const collectComposeProjectFields = (
  extensions: AppPlan["extensions"],
): ReadonlyArray<ComposeProjectFieldUse> => {
  const compose = extensions.compose;
  if (!isRecord(compose)) return [];
  return ComposeProjectFieldKey.literals.flatMap((key) => (compose[key] === undefined ? [] : [{ key }]));
};

export const findUnsupportedComposeProjectField = (
  uses: ReadonlyArray<ComposeProjectFieldUse>,
  capabilities: ComposeProjectFieldCapabilityView,
): ComposeProjectFieldUse | undefined => {
  const supported = capabilities.composeProjectFields?.supported ?? [];
  return uses.find(({ key }) => capabilities.composeSpec !== "native" || !supported.includes(key));
};
