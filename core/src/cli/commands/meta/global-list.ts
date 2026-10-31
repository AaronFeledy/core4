import type { GlobalListResult } from "@lando/engine/operations/global-list";
import { type SummaryDocument, formatSummary } from "@lando/renderer/summary";
import { type RenderContext, isDecoratedContext, summaryPaintOptions } from "../../renderer-boundary";

const buildGlobalListSummary = (result: GlobalListResult): SummaryDocument => {
  const rows = result.services.map((service) => ({
    label: service.id,
    tone:
      service.state === "enabled"
        ? ("ok" as const)
        : service.state === "disabled"
          ? ("skipped" as const)
          : ("warn" as const),
    value: service.state,
    fields: [
      { label: "plugin", value: service.plugin },
      { label: "policy", value: service.source },
      ...(service.reasons.length === 0 ? [] : [{ label: "reason", value: service.reasons.join(", ") }]),
      { label: "commands", value: service.commands.length === 0 ? "none" : service.commands.join(", ") },
      ...(service.summary === undefined ? [] : [{ label: "summary", value: service.summary }]),
    ],
  }));
  return {
    title: "GLOBAL SERVICES",
    tone: "info",
    sections: [
      {
        title: "services",
        rows,
        notes: [
          ...result.diagnostics,
          ...(rows.length === 0 ? ["No plugins contribute global services."] : []),
        ],
      },
    ],
    footer: `Revision ${result.revision}; ${result.services.length} services; ${result.retainedPolicies.length} retained policy records`,
  };
};

export const renderGlobalListResult = (result: GlobalListResult, ctx?: RenderContext): string => {
  if (isDecoratedContext(ctx)) return formatSummary(buildGlobalListSummary(result), summaryPaintOptions(ctx));
  const rows = result.services.map((service) => {
    const commands = service.commands.length === 0 ? "-" : service.commands.join(",");
    return `${service.id}\t${service.state}\t${service.plugin}\t${service.source}\t${service.reasons.join(",") || "-"}\t${commands}`;
  });
  return [
    `Policy revision: ${result.revision}`,
    ...result.diagnostics,
    ...(rows.length === 0
      ? ["(no global services)"]
      : ["service\tstate\tplugin\tpolicy\treason\tcommands", ...rows]),
    ...result.retainedPolicies.map(
      (policy) =>
        `Retained policy: ${policy.plugin}; ${policy.enabled === undefined ? "individual preferences" : policy.enabled ? "enabled" : "disabled"}; contributions: ${policy.contributions.map((entry) => `${entry.id}=${(entry.enabled ?? policy.enabled ?? entry.defaultEnabled) ? "enabled" : "disabled"}`).join(", ") || "none"}`,
    ),
  ].join("\n");
};
