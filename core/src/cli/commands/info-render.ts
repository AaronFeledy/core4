import type { InfoAppResult, InfoAppService, InfoLogSource } from "@lando/sdk/app";

import { linkKnownHttpUrls } from "@lando/renderer/console-layout";
import {
  type SummaryDocument,
  type SummaryRow,
  type SummaryTone,
  formatSummary,
  worstSummaryTone,
} from "@lando/renderer/summary";
import { escapeDiagnosticText } from "../diagnostic-text";
import type { RenderContext } from "../renderer-boundary";
import { contextAllowsHyperlinks, isDecoratedContext, summaryPaintOptions } from "../renderer-boundary";
import { connectionFields, scopedConnectionText, unambiguousHostHttpUrls } from "./connection-summary";
import { fileSyncSection, plainFileSyncLines } from "./info-file-sync-render.ts";
import { homeFields, plainStorageRows, storageFields, storageRemedy } from "./info-storage-render";
import { INFO_STATUS_TONES, summaryToneFromTable } from "./service-summary";

type InfoResultWithHostProxy = InfoAppResult & {
  readonly hostProxy?: {
    readonly runLando: {
      readonly availability: "available" | "unavailable";
      readonly reason?: string;
    };
  };
};

const hasHostProxy = (result: InfoAppResult): result is InfoResultWithHostProxy => "hostProxy" in result;

const hostProxyFor = (result: InfoAppResult) => (hasHostProxy(result) ? result.hostProxy : undefined);

const infoStatusTone = summaryToneFromTable(INFO_STATUS_TONES, "info");

const logSourceFields = (sources: ReadonlyArray<InfoLogSource>): NonNullable<SummaryRow["fields"]> => {
  if (sources.length === 0) return [];
  const reasons = [
    ...new Set(sources.flatMap((source) => (source.reason === undefined ? [] : [source.reason]))),
  ];
  const availability = (source: InfoLogSource): string =>
    source.availability === "redirected-to-console" ? "console" : source.availability;
  return [
    {
      label: "log sources",
      value: sources.map((source) => `${source.id} [${availability(source)}]`).join(", "),
    },
    ...(reasons.length === 0 ? [] : [{ label: "log details", value: reasons.join(" ") }]),
  ];
};

const credsText = (creds: NonNullable<InfoAppService["creds"]>): string => {
  if ("engine" in creds) return `engine=${creds.engine} path=${creds.path}`;
  const parts = [`user=${creds.user}`, `database=${creds.database}`, `password=${creds.password}`];
  if (creds.rootPassword !== undefined) parts.push(`root-password=${creds.rootPassword}`);
  return parts.join(" ");
};

const detailList = new Intl.ListFormat("en", { type: "conjunction" });

const planMetadataFields = (service: InfoAppService): NonNullable<SummaryRow["fields"]> =>
  [
    ...(service.artifact === undefined
      ? []
      : [
          {
            label: "artifact",
            value:
              service.artifact.kind === "ref"
                ? `${service.artifact.ref}${service.artifact.digest === undefined ? "" : ` (${service.artifact.digest})`}`
                : `build${service.artifact.contentHash === undefined ? "" : ` (${service.artifact.contentHash})`}`,
          },
        ]),
    ...(service.user === undefined ? [] : [{ label: "user", value: service.user }]),
  ].map((field) => ({ ...field, value: escapeDiagnosticText(field.value) }));

/** One pointer to the JSON contract for the details the summary leaves out. */
const jsonDetailsNote = (hasLogSources: boolean, hasStorage: boolean): string => {
  const details = [
    ...(hasLogSources ? ["log paths", "strategies"] : []),
    ...(hasStorage ? ["mount sources"] : []),
  ];
  return `Run \`lando info --format=json\` for ${detailList.format(details)}.`;
};

export const buildInfoSummary = (result: InfoAppResult): SummaryDocument => {
  const hostProxy = hostProxyFor(result);
  const projectFiles = fileSyncSection(result.fileSync);
  const rows: SummaryRow[] = result.services.map((service) => {
    const remedy = storageRemedy(service);
    return {
      label: service.service,
      tone: infoStatusTone(service.status),
      value: service.status,
      fields: [
        { label: "type", value: service.type },
        { label: "provider", value: service.provider },
        ...planMetadataFields(service),
        ...connectionFields(service.connections),
        ...storageFields(service),
        ...homeFields(service),
        ...(service.logSources === undefined ? [] : logSourceFields(service.logSources)),
        ...(service.creds === undefined ? [] : [{ label: "creds", value: credsText(service.creds) }]),
      ],
      ...(remedy === undefined ? {} : { remedy }),
    };
  });
  const hasLogSources = result.services.some((service) => (service.logSources?.length ?? 0) > 0);
  const hasStorage = result.services.some((service) => (service.mounts?.length ?? 0) > 0);
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
        ...(rows.length === 0
          ? { notes: ["No services are defined for this app."] }
          : hasLogSources || hasStorage
            ? { notes: [jsonDetailsNote(hasLogSources, hasStorage)] }
            : {}),
      },
      ...(projectFiles === undefined ? [] : [projectFiles]),
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
  const hostProxy = hostProxyFor(result);
  if (hostProxy === undefined) return [];
  const reason = hostProxy.runLando.reason === undefined ? "" : `\t${hostProxy.runLando.reason}`;
  return [`host-proxy\trunLando\t${hostProxy.runLando.availability}${reason}`];
};

// Links must open from the host, so app-network `internal` addresses are deliberately left out.
const infoHttpUrls = (result: InfoAppResult): ReadonlyArray<string> =>
  unambiguousHostHttpUrls(result.services.flatMap((service) => service.connections));

export const renderInfoAppResult = (result: InfoAppResult, ctx?: RenderContext): string => {
  const rendered = isDecoratedContext(ctx)
    ? formatSummary(buildInfoSummary(result), summaryPaintOptions(ctx))
    : renderPlainInfoAppResult(result);
  return contextAllowsHyperlinks(ctx) ? linkKnownHttpUrls(rendered, infoHttpUrls(result)) : rendered;
};

const renderPlainInfoAppResult = (result: InfoAppResult): string => {
  const extra = [...plainFileSyncLines(result.fileSync), ...hostProxyLines(result), ...agentEnvLines(result)];
  if (result.services.length === 0) return [`${result.app}`, "(no services)", ...extra].join("\n");
  const rows = result.services.flatMap((service) => {
    const base = `${service.service}\t${service.status}\t${scopedConnectionText(service.connections, "host") || "not published"}\t${scopedConnectionText(service.connections, "app") || "-"}`;
    const logRows = (service.logSources ?? []).map((source) => {
      const reason = source.reason === undefined ? "" : `\t${source.reason}`;
      return `${service.service}\tlog-source\t${source.id}\t${source.path}\t${source.strategy}\t${source.availability}${reason}`;
    });
    const credsRows =
      service.creds === undefined ? [] : [`${service.service}\tcreds\t${credsText(service.creds)}`];
    const homeRows = homeFields(service).map(
      (field) => `${escapeDiagnosticText(service.service)}\t${field.label}\t${field.value}`,
    );
    const metadataRows = planMetadataFields(service).map(
      (field) => `${escapeDiagnosticText(service.service)}\t${field.label}\t${field.value}`,
    );
    return [base, ...metadataRows, ...plainStorageRows(service), ...homeRows, ...logRows, ...credsRows];
  });
  return [`app\t${result.app}`, "service\tstate\tHost\tApp Network", ...rows, ...extra].join("\n");
};
