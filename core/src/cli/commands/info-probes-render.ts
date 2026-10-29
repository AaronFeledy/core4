import type { SummaryField } from "@lando/renderer/summary";
import type { InfoAppService } from "@lando/sdk/app";
import { escapeDiagnosticText } from "../diagnostic-text.ts";

type ReadinessInfo = NonNullable<InfoAppService["readiness"]>;
type ProbeInfo = NonNullable<ReadinessInfo["check"]>;

const healthLabels = {
  "not-monitored": "not monitored",
  unknown: "not observed",
  starting: "starting",
  healthy: "healthy",
  unhealthy: "unhealthy",
} satisfies Readonly<Record<NonNullable<InfoAppService["health"]>["state"], string>>;

const readinessLabels = {
  disabled: "disabled",
  "not-configured": "not configured",
  "not-observed": "configured, not observed",
} satisfies Readonly<Record<ReadinessInfo["state"], string>>;

const sourceLabels = {
  authored: "",
  contributed: "service default",
  healthcheck: "from healthcheck",
  unknown: "source not recorded",
  none: "",
} satisfies Readonly<Record<ReadinessInfo["source"], string>>;

const executionLabel = (probe: ProbeInfo): string => {
  switch (probe.target) {
    case "host":
      return "host, current CLI user";
    case "service":
      return probe.user === undefined ? "service, image user" : `service, user ${probe.user}`;
    default:
      return probe.target satisfies never;
  }
};

const readinessLabel = (readiness: ReadinessInfo): string => {
  const label = readinessLabels[readiness.state];
  if (readiness.state !== "not-observed" || readiness.check === undefined) return label;
  const source = sourceLabels[readiness.source];
  return `${label} (${executionLabel(readiness.check)}${source === "" ? "" : `; ${source}`})`;
};

export const probeFields = (service: InfoAppService): readonly SummaryField[] => [
  ...(service.health === undefined ? [] : [{ label: "health", value: healthLabels[service.health.state] }]),
  ...(service.readiness === undefined
    ? []
    : [{ label: "readiness", value: escapeDiagnosticText(readinessLabel(service.readiness)) }]),
];
