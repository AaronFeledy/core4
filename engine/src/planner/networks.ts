import type { LandofileProvenance } from "@lando/landofile/provenance";
import { getLandofileValueSource } from "@lando/landofile/validation";
import { LandofileValidationError } from "@lando/sdk/errors";
import {
  type AppIdentity,
  type LandofileShape,
  type ServiceConfig,
  landoNetworkingPlan,
  validationIssue,
} from "@lando/sdk/schema";
import { Effect } from "effect";
import { networkServicesWithClones } from "./cloned-services.ts";

export const planNetworking = Effect.fn("AppPlanner.planNetworking")(function* (input: {
  readonly landofile: LandofileShape;
  readonly provenance?: LandofileProvenance | undefined;
  readonly appRoot: string;
  readonly slug: string;
  readonly identity: AppIdentity | undefined;
  readonly sharedCrossAppNetwork: boolean;
  readonly serviceNames: readonly string[];
  readonly serviceHostnames: Parameters<typeof landoNetworkingPlan>[0]["serviceHostnames"];
  readonly resolvedServices: Parameters<typeof networkServicesWithClones>[0];
  readonly clones: Parameters<typeof networkServicesWithClones>[1];
}) {
  const perAppBridge = input.slug !== "global";
  const authored = yield* normalizeNetworks({
    landofile: input.landofile,
    provenance: input.provenance,
    services: networkServicesWithClones(input.resolvedServices, input.clones, input.serviceNames),
    appRoot: input.appRoot,
    perAppBridge,
  });
  return input.serviceNames.length === 0
    ? undefined
    : landoNetworkingPlan({ ...input, perAppBridge, ...authored });
});

/** Normalize canonical service attachments without changing their preserved Compose record. */
export const normalizeNetworks = Effect.fn("AppPlanner.normalizeNetworks")(function* (input: {
  readonly landofile: LandofileShape;
  readonly provenance?: LandofileProvenance | undefined;
  readonly services: Readonly<Record<string, Pick<ServiceConfig, "networks">>>;
  readonly appRoot: string;
  readonly perAppBridge: boolean;
}) {
  const bridgeAliases: Record<string, readonly string[]> = {};
  const members = new Map<string, Record<string, readonly string[]>>();
  for (const [service, config] of Object.entries(input.services)) {
    for (const [key, attachment] of Object.entries(config.networks ?? {})) {
      if (key === "default") {
        if (!input.perAppBridge) {
          const message = "The global app has no per-app default network.";
          const remediation = "Remove default and join a separately declared network instead.";
          const path = ["services", service, "networks", key];
          const source = getLandofileValueSource(input.provenance, path);
          return yield* Effect.fail(
            new LandofileValidationError({
              file: source?.file ?? input.appRoot,
              message,
              remediation,
              issues: [
                {
                  ...validationIssue(path, message),
                  suggestion: remediation,
                  ...(source === undefined ? {} : { source }),
                },
              ],
            }),
          );
        }
        bridgeAliases[service] = attachment.aliases ?? [];
        continue;
      }
      const joined = members.get(key) ?? {};
      joined[service] = attachment.aliases ?? [];
      members.set(key, joined);
    }
  }
  // Resolved validation already rejected undeclared keys and duplicate physical names.
  const authoredNetworks: NonNullable<
    Parameters<typeof landoNetworkingPlan>[0]["authoredNetworks"]
  >[number][] = [];
  for (const [key, definition] of Object.entries(input.landofile.networks ?? {})) {
    const joined = members.get(key);
    if (joined === undefined) continue;
    authoredNetworks.push({
      key,
      external: definition.external === true,
      name: definition.name,
      driver: definition.driver,
      members: joined,
    });
  }
  return { authoredNetworks, bridgeAliases };
});
