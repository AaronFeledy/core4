import type { GlobalStatusResult } from "@lando/engine/operations/global-status";
export {
  type GlobalStatusOptions,
  type GlobalStatusResult,
  GlobalStatusResultSchema,
  globalStatus,
} from "@lando/engine/operations/global-status";
import { linkKnownHttpUrls } from "@lando/renderer/console-layout";
import { type SummaryDocument, formatSummary, worstSummaryTone } from "@lando/renderer/summary";
import {
  type RenderContext,
  contextAllowsHyperlinks,
  isDecoratedContext,
  summaryPaintOptions,
} from "../../renderer-boundary";
import { connectionFields, scopedConnectionText, unambiguousHostHttpUrls } from "../connection-summary";
import { INFO_STATUS_TONES, summaryToneFromTable } from "../service-summary";

const globalStatusTone = summaryToneFromTable(INFO_STATUS_TONES, "info");

export const buildGlobalStatusSummary = (result: GlobalStatusResult): SummaryDocument => {
  const rows = result.services.map((service) => ({
    label: service.service,
    tone: globalStatusTone(service.status),
    value: service.status,
    fields: [
      { label: "desired", value: service.desired },
      ...(service.policy?.reasons.length
        ? [{ label: "reason", value: service.policy.reasons.join(", ") }]
        : []),
      ...(service.pending.length === 0
        ? []
        : [{ label: "pending", value: service.pending.map((work) => work.phase).join(", ") }]),
      { label: "type", value: service.type },
      { label: "provider", value: service.provider },
      ...connectionFields(service.connections),
    ],
  }));
  return {
    title: "GLOBAL APP",
    subtitle: `${result.app}; policy ${result.policyState}; runtime ${result.runtimeState}`,
    tone: rows.length === 0 ? "info" : worstSummaryTone(rows.map((row) => row.tone)),
    sections: [
      {
        title: "services",
        rows,
        notes: [
          ...result.diagnostics,
          ...result.pending.map((work) => `${work.phase}: ${work.message}`),
          ...(result.materialized ? [] : ["Global configuration is not materialized."]),
          ...(rows.length === 0 ? ["No global services are known."] : []),
        ],
      },
    ],
    footer: `${result.services.length} services; ${result.pending.length} pending reconciliation phases`,
  };
};

export const renderGlobalStatusResult = (
  result: GlobalStatusResult,
  _format: "json" | "table" = "table",
  ctx?: RenderContext,
): string => {
  void _format;
  if (isDecoratedContext(ctx)) {
    const text = formatSummary(buildGlobalStatusSummary(result), summaryPaintOptions(ctx));
    return contextAllowsHyperlinks(ctx)
      ? linkKnownHttpUrls(
          text,
          unambiguousHostHttpUrls(result.services.flatMap((service) => service.connections)),
        )
      : text;
  }
  const rows = result.services.map((service) => {
    return `${service.service}\t${service.desired}\t${service.status}\t${service.pending.map((work) => work.phase).join(",") || "-"}\t${scopedConnectionText(service.connections, "host") || "not published"}\t${scopedConnectionText(service.connections, "app") || "-"}`;
  });
  return [
    `app\t${result.app}`,
    `policy\t${result.policyState}\truntime\t${result.runtimeState}`,
    ...(result.materialized ? [] : ["Global configuration is not materialized."]),
    ...result.diagnostics,
    ...result.pending.map((work) => `${work.phase}: ${work.message}`),
    ...(rows.length === 0
      ? ["(no services)"]
      : ["service\tdesired\tstate\tpending\tHost\tApp Network", ...rows]),
  ].join("\n");
};
