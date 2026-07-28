import type { ProviderCapabilities, ServiceConfig, ServicePlan } from "@lando/sdk/schema";

const COMPOSE_NATIVE_SERVICE_FIELDS = ["networks", "configs", "secrets", "profiles", "labels"] as const;

export interface ComposeNativeFieldUse {
  readonly service: string;
  readonly key: string;
}

type ComposeCapabilityView = Pick<ProviderCapabilities, "composeSpec">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isComposeNativeServiceField = (key: string): boolean =>
  key.startsWith("x-") || COMPOSE_NATIVE_SERVICE_FIELDS.some((field) => field === key);

const compareUses = (left: ComposeNativeFieldUse, right: ComposeNativeFieldUse): number => {
  if (left.service < right.service) return -1;
  if (left.service > right.service) return 1;
  return left.key.localeCompare(right.key);
};

export const mergeComposeExtension = (servicePlan: ServicePlan, service: ServiceConfig): ServicePlan => {
  const startInterval = service.healthcheck?.startInterval;
  const hasDependencyRestart =
    service.dependsOn?.some((dependency) => dependency.restart !== undefined) ?? false;
  const nativeEntries = Object.entries(service).filter(
    ([key, value]) => value !== undefined && isComposeNativeServiceField(key),
  );
  if (
    service.labels === undefined &&
    startInterval === undefined &&
    !hasDependencyRestart &&
    nativeEntries.length === 0
  ) {
    return servicePlan;
  }

  const composeExtension = servicePlan.extensions.compose;
  const compose = isRecord(composeExtension) ? { ...composeExtension } : {};
  if (service.labels !== undefined) {
    compose.labels = {
      ...(isRecord(compose.labels) ? compose.labels : {}),
      ...service.labels,
    };
  }
  if (startInterval !== undefined) {
    compose.healthcheck = {
      ...(isRecord(compose.healthcheck) ? compose.healthcheck : {}),
      start_interval: startInterval,
    };
  }
  if (hasDependencyRestart) {
    const dependsOn = isRecord(compose.depends_on) ? { ...compose.depends_on } : {};
    for (const dependency of service.dependsOn ?? []) {
      if (dependency.restart === undefined) continue;
      const existing = dependsOn[dependency.service];
      dependsOn[dependency.service] = {
        ...(isRecord(existing) ? existing : {}),
        restart: dependency.restart,
      };
    }
    compose.depends_on = dependsOn;
  }
  for (const [key, value] of nativeEntries) compose[key] = value;

  return {
    ...servicePlan,
    extensions: {
      ...servicePlan.extensions,
      compose,
    },
  };
};

export const collectComposeNativeFields = (
  services: Readonly<Record<string, ServicePlan>>,
): ReadonlyArray<ComposeNativeFieldUse> => {
  const uses: ComposeNativeFieldUse[] = [];
  for (const servicePlan of Object.values(services)) {
    const compose = servicePlan.extensions.compose;
    if (!isRecord(compose)) continue;
    for (const key of Object.keys(compose)) {
      if (isComposeNativeServiceField(key)) uses.push({ service: servicePlan.name, key });
    }
  }
  return uses.sort(compareUses);
};

export const findUnsupportedComposeNativeField = (
  uses: ReadonlyArray<ComposeNativeFieldUse>,
  capabilities: ComposeCapabilityView,
): ComposeNativeFieldUse | undefined =>
  capabilities.composeSpec === "native" ? undefined : [...uses].sort(compareUses)[0];
