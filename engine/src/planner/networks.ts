import { getLandofileValueSource } from "@lando/landofile/validation";
import { LandofileValidationError } from "@lando/sdk/errors";
import {
  type LandofileShape,
  type ServiceConfig,
  type landoNetworkingPlan,
  validationIssue,
} from "@lando/sdk/schema";
import { Effect } from "effect";

/** Normalize canonical service attachments without changing their preserved Compose record. */
export const normalizeNetworks = Effect.fn("AppPlanner.normalizeNetworks")(function* (input: {
  readonly landofile: LandofileShape;
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
          const source = getLandofileValueSource(input.landofile, path);
          return yield* Effect.fail(
            new LandofileValidationError({
              file: source !== undefined && "file" in source ? source.file : `${input.appRoot}/.lando.yml`,
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
