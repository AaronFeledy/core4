import { ComposePreservedPathKey } from "@lando/sdk/schema";
import type { ProviderCapabilities, ServicePlan } from "@lando/sdk/schema";
import { Predicate } from "effect";

type ComposePreservedPathUse = {
  readonly service: string;
  readonly key: ComposePreservedPathKey;
};

type ComposePreservedPathCapabilityView = Pick<ProviderCapabilities, "composePreservedPaths" | "composeSpec">;

const compareUses = (left: ComposePreservedPathUse, right: ComposePreservedPathUse): number => {
  if (left.service < right.service) return -1;
  if (left.service > right.service) return 1;
  return (
    ComposePreservedPathKey.literals.indexOf(left.key) - ComposePreservedPathKey.literals.indexOf(right.key)
  );
};

export const collectComposePreservedPaths = (
  services: Readonly<Record<string, ServicePlan>>,
): ReadonlyArray<ComposePreservedPathUse> => {
  const uses: ComposePreservedPathUse[] = [];

  for (const servicePlan of Object.values(services)) {
    const compose = servicePlan.extensions.compose;
    if (!Predicate.isObject(compose)) continue;

    const dependsOn = compose.depends_on;
    if (
      Predicate.isObject(dependsOn) &&
      Object.values(dependsOn).some(
        (dependency) => Predicate.isObject(dependency) && dependency.restart !== undefined,
      )
    ) {
      uses.push({ service: servicePlan.name, key: "depends_on.*.restart" });
    }

    const healthcheck = compose.healthcheck;
    if (Predicate.isObject(healthcheck) && healthcheck.start_interval !== undefined) {
      uses.push({ service: servicePlan.name, key: "healthcheck.start_interval" });
    }
  }

  return uses.sort(compareUses);
};

export const findUnsupportedComposePreservedPath = (
  uses: ReadonlyArray<ComposePreservedPathUse>,
  capabilities: ComposePreservedPathCapabilityView,
): ComposePreservedPathUse | undefined => {
  const supported = capabilities.composePreservedPaths?.supported ?? [];
  return [...uses]
    .sort(compareUses)
    .find((use) => capabilities.composeSpec !== "native" || !supported.includes(use.key));
};
