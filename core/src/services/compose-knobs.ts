import { ComposeServiceKnobKey } from "@lando/sdk/schema";
import type { ProviderCapabilities, ServiceConfig, ServicePlan } from "@lando/sdk/schema";

export type ComposeKnobUse = {
  readonly service: string;
  readonly key: ComposeServiceKnobKey;
};

type ComposeCapabilityView = Pick<ProviderCapabilities, "composeSpec" | "composeKnobs">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringList = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string");

const compareKnobUses = (left: ComposeKnobUse, right: ComposeKnobUse): number => {
  if (left.service < right.service) return -1;
  if (left.service > right.service) return 1;
  return ComposeServiceKnobKey.literals.indexOf(left.key) - ComposeServiceKnobKey.literals.indexOf(right.key);
};

export const mergeComposeKnobs = (servicePlan: ServicePlan, serviceConfig: ServiceConfig): ServicePlan => {
  const currentCompose = servicePlan.extensions.compose;
  const compose = isRecord(currentCompose) ? { ...currentCompose } : {};
  let changed = false;

  for (const key of ComposeServiceKnobKey.literals) {
    if (key === "tmpfs") {
      if (serviceConfig.tmpfs === undefined) continue;
      const existing = isStringList(compose.tmpfs) ? compose.tmpfs : [];
      compose.tmpfs = [...existing, ...serviceConfig.tmpfs];
      changed = true;
      continue;
    }

    if (key === "deploy.resources") {
      if (serviceConfig.deploy === undefined) continue;
      compose.deploy = serviceConfig.deploy;
      changed = true;
      continue;
    }

    const value = serviceConfig[key];
    if (value === undefined) continue;
    compose[key] = value;
    changed = true;
  }

  if (!changed) return servicePlan;
  return {
    ...servicePlan,
    extensions: {
      ...servicePlan.extensions,
      compose,
    },
  };
};

export const collectComposeKnobs = (
  services: Readonly<Record<string, ServicePlan>>,
): ReadonlyArray<ComposeKnobUse> => {
  const uses: Array<ComposeKnobUse> = [];

  for (const servicePlan of Object.values(services)) {
    const compose = servicePlan.extensions.compose;
    if (!isRecord(compose)) continue;

    for (const key of ComposeServiceKnobKey.literals) {
      if (key === "deploy.resources") {
        const deploy = compose.deploy;
        if (isRecord(deploy) && deploy.resources !== undefined) {
          uses.push({ service: servicePlan.name, key });
        }
        continue;
      }

      if (compose[key] !== undefined) uses.push({ service: servicePlan.name, key });
    }
  }

  return uses.sort(compareKnobUses);
};

export const findUnsupportedComposeKnob = (
  uses: ReadonlyArray<ComposeKnobUse>,
  capabilities: ComposeCapabilityView,
): ComposeKnobUse | undefined => {
  const supported = capabilities.composeKnobs?.supported ?? [];
  for (const use of [...uses].sort(compareKnobUses)) {
    if (capabilities.composeSpec !== "native" || !supported.includes(use.key)) return use;
  }
  return undefined;
};
