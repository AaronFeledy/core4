import type { InfoAppResult, InfoLogSource, InfoServiceStatus } from "@lando/sdk/app";

import { type RenderContext, isDecoratedContext } from "../renderer-boundary.ts";
import {
  type SummaryDocument,
  type SummaryRow,
  type SummaryTone,
  formatSummary,
  worstSummaryTone,
} from "../renderer/summary.ts";

type InfoResultWithHostProxy = InfoAppResult & {
  readonly hostProxy?: {
    readonly runLando: {
      readonly availability: "available" | "unavailable";
      readonly reason?: string;
    };
  };
};

const infoStatusTone = (status: InfoServiceStatus): SummaryTone => {
  switch (status) {
    case "running":
    case "healthy":
      return "ok";
    case "starting":
      return "pending";
    case "stopped":
      return "skipped";
    case "unhealthy":
    case "error":
      return "error";
    default:
      return "info";
  }
};

const logSourceText = (source: InfoLogSource): string => {
  const availability =
    source.reason === undefined ? source.availability : `${source.availability}: ${source.reason}`;
  return `${source.id} ${source.path} (${source.strategy}, ${availability})`;
};

export const buildInfoSummary = (result: InfoAppResult): SummaryDocument => {
  const hostProxy = (result as InfoResultWithHostProxy).hostProxy;
  const rows: SummaryRow[] = result.services.map((service) => ({
    label: service.service,
    tone: infoStatusTone(service.status),
    value: service.status,
    fields: [
      { label: "type", value: service.type },
      { label: "provider", value: service.provider },
      {
        label: "endpoints",
        value: service.endpoints.length === 0 ? "no endpoints" : service.endpoints.join(", "),
      },
      ...(service.logSources === undefined
        ? []
        : [{ label: "log sources", value: service.logSources.map(logSourceText).join(", ") }]),
    ],
  }));
  const agentEnvSection =
    result.agentEnv === undefined
      ? []
      : [
          {
            title: "agent env",
            rows: [
              {
                label: "forwarding",
                tone: (result.agentEnv.enabled ? "ok" : "skipped") as SummaryTone,
                value: result.agentEnv.enabled ? "enabled" : "disabled",
                fields: [
                  {
                    label: "forwarded",
                    value:
                      result.agentEnv.forwarded.length === 0
                        ? "(none)"
                        : result.agentEnv.forwarded.join(", "),
                  },
                ],
              },
            ],
          },
        ];
  return {
    title: "APP INFO",
    subtitle: result.app,
    tone: result.services.length === 0 ? "info" : worstSummaryTone(rows.map((row) => row.tone ?? "info")),
    sections: [
      {
        title: "services",
        rows,
        ...(rows.length === 0 ? { notes: ["No services are defined for this app."] } : {}),
      },
      ...(hostProxy === undefined
        ? []
        : [
            {
              title: "host-proxy",
              rows: [
                {
                  label: "runLando",
                  tone: (hostProxy.runLando.availability === "available" ? "ok" : "skipped") as SummaryTone,
                  value: hostProxy.runLando.availability,
                  fields:
                    hostProxy.runLando.reason === undefined
                      ? []
                      : [{ label: "reason", value: hostProxy.runLando.reason }],
                },
              ],
            },
          ]),
      ...agentEnvSection,
    ],
    footer: `${result.services.length} services`,
  };
};

const agentEnvLines = (result: InfoAppResult): ReadonlyArray<string> => {
  if (result.agentEnv === undefined) return [];
  const forwarded = result.agentEnv.forwarded.length === 0 ? "(none)" : result.agentEnv.forwarded.join(", ");
  return [`agent-env\t${result.agentEnv.enabled ? "enabled" : "disabled"}\t${forwarded}`];
};

const hostProxyLines = (result: InfoAppResult): ReadonlyArray<string> => {
  const hostProxy = (result as InfoResultWithHostProxy).hostProxy;
  if (hostProxy === undefined) return [];
  const reason = hostProxy.runLando.reason === undefined ? "" : `\t${hostProxy.runLando.reason}`;
  return [`host-proxy\trunLando\t${hostProxy.runLando.availability}${reason}`];
};

export const renderInfoAppResult = (result: InfoAppResult, ctx?: RenderContext): string => {
  if (isDecoratedContext(ctx)) return formatSummary(buildInfoSummary(result), { columns: ctx?.columns });
  const extra = [...hostProxyLines(result), ...agentEnvLines(result)];
  if (result.services.length === 0) return [`${result.app}`, "(no services)", ...extra].join("\n");
  const rows = result.services.flatMap((service) => {
    const endpoints = service.endpoints;
    const renderedEndpoints = endpoints.length === 0 ? "no endpoints" : endpoints.join(", ");
    const base = `${service.service}\t${service.status}\t${renderedEndpoints}`;
    const logRows = (service.logSources ?? []).map((source) => {
      const reason = source.reason === undefined ? "" : `\t${source.reason}`;
      return `${service.service}\tlog-source\t${source.id}\t${source.path}\t${source.strategy}\t${source.availability}${reason}`;
    });
    return [base, ...logRows];
  });
  return [`app\t${result.app}`, "service\tstate\tendpoints", ...rows, ...extra].join("\n");
};
