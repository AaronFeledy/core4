import { ComposeServiceFieldKey } from "@lando/sdk/schema";
import type { ProviderCapabilities, ServicePlan } from "@lando/sdk/schema";

export type ComposeServiceFieldUse = {
  readonly service: string;
  readonly key: string;
  readonly family: ComposeServiceFieldKey;
};

type ComposeServiceFieldCapabilityView = Pick<ProviderCapabilities, "composeSpec" | "composeServiceFields">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const compareServiceFieldUses = (left: ComposeServiceFieldUse, right: ComposeServiceFieldUse): number => {
  if (left.service < right.service) return -1;
  if (left.service > right.service) return 1;
  const familyOrder =
    ComposeServiceFieldKey.literals.indexOf(left.family) -
    ComposeServiceFieldKey.literals.indexOf(right.family);
  return familyOrder === 0 ? left.key.localeCompare(right.key) : familyOrder;
};

export const collectComposeServiceFields = (
  services: Readonly<Record<string, ServicePlan>>,
): ReadonlyArray<ComposeServiceFieldUse> => {
  const uses: Array<ComposeServiceFieldUse> = [];

  for (const servicePlan of Object.values(services)) {
    const compose = servicePlan.extensions.compose;
    if (!isRecord(compose)) continue;

    for (const family of ComposeServiceFieldKey.literals) {
      if (compose[family] !== undefined) {
        uses.push({ service: servicePlan.name, key: family, family });
      }
    }
  }

  return uses.sort(compareServiceFieldUses);
};

export const findUnsupportedComposeServiceField = (
  uses: ReadonlyArray<ComposeServiceFieldUse>,
  capabilities: ComposeServiceFieldCapabilityView,
): ComposeServiceFieldUse | undefined => {
  const supported = capabilities.composeServiceFields?.supported ?? [];
  for (const use of [...uses].sort(compareServiceFieldUses)) {
    if (capabilities.composeSpec !== "native" || !supported.includes(use.family)) return use;
  }
  return undefined;
};
