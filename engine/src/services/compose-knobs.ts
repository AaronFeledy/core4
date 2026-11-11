import { ComposeServiceKnobKey } from "@lando/sdk/schema";
import type { ProviderCapabilities, ServiceConfig, ServicePlan } from "@lando/sdk/schema";
import { Predicate } from "effect";

export type ComposeKnobUse = {
  readonly service: string;
  readonly key: ComposeServiceKnobKey;
};

type ComposeCapabilityView = Pick<ProviderCapabilities, "composeSpec" | "composeKnobs">;

const compareKnobUses = (left: ComposeKnobUse, right: ComposeKnobUse): number => {
  if (left.service < right.service) return -1;
  if (left.service > right.service) return 1;
  return ComposeServiceKnobKey.literals.indexOf(left.key) - ComposeServiceKnobKey.literals.indexOf(right.key);
};

export const mergeComposeKnobs = <S extends Pick<ServicePlan, "extensions">>(
  servicePlan: S,
  serviceConfig: ServiceConfig,
): S => {
  const currentCompose = servicePlan.extensions.compose;
  const compose = Predicate.isObject(currentCompose) ? { ...currentCompose } : {};
  let changed = false;

  for (const key of ComposeServiceKnobKey.literals) {
    const field =
      key === "deploy.resources" || key === "deploy.resources.reservations.devices" ? "deploy" : key;
    const value = serviceConfig[field];
    if (value === undefined) continue;
    compose[field] = value;
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

const has = (record: unknown, key: string): boolean =>
  Predicate.isObject(record) && record[key] !== undefined;

// `deploy.resources` covers the resource controls; device requests are their own capability.
const usesResourceControl = (resources: unknown): boolean => {
  if (!Predicate.isObject(resources)) return false;
  const { limits, reservations } = resources;
  return ["memory", "cpus", "pids"].some((key) => has(limits, key)) || has(reservations, "memory");
};

const usesDeviceReservation = (resources: unknown): boolean =>
  Predicate.isObject(resources) && has(resources.reservations, "devices");

export const collectComposeKnobs = (
  services: Readonly<Record<string, Pick<ServicePlan, "name" | "extensions">>>,
): ReadonlyArray<ComposeKnobUse> => {
  const uses: Array<ComposeKnobUse> = [];

  for (const servicePlan of Object.values(services)) {
    const compose = servicePlan.extensions.compose;
    if (!Predicate.isObject(compose)) continue;

    const resources = Predicate.isObject(compose.deploy) ? compose.deploy.resources : undefined;
    for (const key of ComposeServiceKnobKey.literals) {
      const used =
        key === "deploy.resources"
          ? usesResourceControl(resources)
          : key === "deploy.resources.reservations.devices"
            ? usesDeviceReservation(resources)
            : compose[key] !== undefined;
      if (used) uses.push({ service: servicePlan.name, key });
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
