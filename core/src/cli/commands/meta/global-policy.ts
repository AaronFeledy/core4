import type { GlobalPolicyChangeResult } from "@lando/engine/operations/global-policy";

export const renderGlobalPolicyChangeResult = (result: GlobalPolicyChangeResult): string =>
  [
    result.dryRun
      ? `Global ${result.operation} preview (revision ${result.revision}); no changes saved.`
      : `Global ${result.operation} completed (revision ${result.revision}).`,
    `Policy: ${result.impact.desired}; ${result.impact.policyChanges ? "preferences change" : "preferences unchanged"}`,
    `Contributions: ${result.contributions.length === 0 ? "none" : result.contributions.join(", ")}`,
    ...(result.plugins.length === 0
      ? []
      : [`Plugin policy applies to current and future contributions: ${result.plugins.join(", ")}`]),
    ...result.states
      .filter((state) => state.state === "blocked" || state.state === "unverified")
      .map((state) => `${state.id}: ${state.state}; ${state.reasons.join(", ")}`),
    ...(result.impact.dependencyBlockers.length === 0
      ? []
      : [`Required by: ${result.impact.dependencyBlockers.join(", ")}`]),
    ...result.impact.consumers.map(
      (consumer) =>
        `Affected ${consumer.kind} app: ${consumer.name} (${consumer.id}, ${consumer.root}, ${consumer.provider}); requires ${consumer.globalServices.join(", ")}${consumer.routes.length === 0 ? "" : `; routes ${consumer.routes.join(", ")}`}`,
    ),
    ...(result.impact.allowDisruption
      ? ["Consumer disruption explicitly acknowledged for this invocation; apps are left running."]
      : []),
    ...result.impact.validationErrors.map((error) => `Validation: ${error}`),
    ...result.impact.routes.map((route) => `Route: ${route.hostname} (${route.service})`),
    ...result.impact.uncertainties.map((uncertainty) => `Unverified: ${uncertainty}`),
    `Containers removed: ${result.servicesRemoved.length === 0 ? "none" : result.servicesRemoved.join(", ")}`,
    ...(result.dist === undefined
      ? []
      : [`Generated configuration: ${result.dist.path} (${result.dist.status})`]),
    "Named volumes preserved.",
    ...(result.operation === "enable"
      ? ["Run `lando global:start` when you want to start enabled services."]
      : []),
  ].join("\n");
