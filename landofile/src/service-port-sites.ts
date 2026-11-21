import { LandofileValidationError } from "@lando/sdk/errors";
import { expressionScopeMembers } from "@lando/sdk/expressions";
import { isPlainRecord } from "@lando/sdk/landofile";
import type { ParsedPendingSite, ValidationIssueSource } from "@lando/sdk/schema";

const servicePortMessages = {
  "host-readiness": "service.port is not supported in host readiness probes; it is a container port.",
  "unsupported-site":
    "service.port is available only in a service's command, entrypoint, extraArgs, or container healthcheck or readiness command.",
  "unsupported-member":
    "Only the direct expression member service.port is supported at service process sites.",
} as const;

export const servicePortSiteError = (
  source: ValidationIssueSource,
  reason: keyof typeof servicePortMessages,
) => {
  const message = servicePortMessages[reason];
  const suggestion =
    "Use {{ service.port }} in a service command, entrypoint, extraArgs, or container healthcheck or readiness command.";
  return new LandofileValidationError({
    file: "file" in source ? source.file : "<landofile>",
    message,
    remediation: suggestion,
    issues: [{ path: source.path, source, rule: "unsupported-expression", message, suggestion }],
  });
};

export const hostReadinessPortSite = (
  document: Record<string, unknown>,
  sites: readonly ParsedPendingSite[],
) => {
  const services = document.services;
  if (!isPlainRecord(services)) return undefined;
  return sites.find((site) => {
    const [section, name, field] = site.path;
    if (section !== "services" || typeof name !== "string" || field !== "readiness") return false;
    const service = services[name];
    if (!isPlainRecord(service) || !isPlainRecord(service.readiness) || service.readiness.target !== "host")
      return false;
    return expressionScopeMembers(site.template, "service").members.has("port");
  });
};
