import { Result, Schema } from "effect";

import { ServiceConfig, type ServicePlan } from "@lando/sdk/schema";
import { quoteYamlScalar, yamlMappingKeyText } from "@lando/sdk/yaml";

export type HostAliasMap = Readonly<Record<string, string | ReadonlyArray<string>>>;

export const realizeHostAliases = (
  planned: ServicePlan["hostAliases"],
  authored: HostAliasMap = {},
): HostAliasMap => {
  const hosts = new Map<string, string | ReadonlyArray<string>>();
  const plannedNames = new Set(planned.map(({ hostname }) => hostname.toLowerCase()));
  for (const { hostname, ip } of planned) {
    const addresses = hosts.get(hostname);
    hosts.set(
      hostname,
      addresses === undefined ? ip : typeof addresses === "string" ? [addresses, ip] : [...addresses, ip],
    );
  }
  for (const [hostname, addresses] of Object.entries(authored)) {
    if (plannedNames.has(hostname.toLowerCase())) continue;
    if (typeof addresses === "string" || addresses.length > 0) hosts.set(hostname, addresses);
  }
  return Object.fromEntries(hosts);
};

export const extraHostEntries = (hosts: HostAliasMap | undefined): ReadonlyArray<string> | undefined => {
  const entries = Object.entries(hosts ?? {}).flatMap(([hostname, addresses]) =>
    (typeof addresses === "string" ? [addresses] : addresses).map((ip) => `${hostname}:${ip}`),
  );
  return entries.length === 0 ? undefined : entries;
};

const decodeHostAliases = Schema.decodeUnknownResult(
  Schema.Struct({ extra_hosts: ServiceConfig.fields.extra_hosts }),
);

export const serviceHostAliases = (
  service: ServicePlan,
  onInvalid: (message: string, details: Record<string, unknown>) => never,
): HostAliasMap => {
  const decoded = decodeHostAliases(service.extensions.compose ?? {});
  if (Result.isFailure(decoded)) {
    return onInvalid("Compose host aliases could not be realized.", {
      service: service.name,
      knob: "extra_hosts",
      issue: decoded.failure.issue,
    });
  }
  return realizeHostAliases(service.hostAliases, decoded.success.extra_hosts);
};

export const writeHostAliases = (lines: string[], hosts: HostAliasMap): void => {
  for (const [hostname, addresses] of Object.entries(hosts).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const key = `      ${yamlMappingKeyText(hostname)}:`;
    if (typeof addresses === "string") lines.push(`${key} ${quoteYamlScalar(addresses)}`);
    else {
      lines.push(key);
      for (const address of addresses) lines.push(`        - ${quoteYamlScalar(address)}`);
    }
  }
};
