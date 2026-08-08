import type { DoctorCheck, DoctorResult, DoctorSelectionRecord } from "./doctor-contract";
import { orderKnownKeys, renderDoctorChecksAsNdjson } from "./doctor-ndjson";
import { DOCTOR_CAPABILITY_FIELDS } from "./doctor-provider";

const orderCapabilityKeys = (capabilities: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const ordered: Record<string, unknown> = {};
  for (const field of DOCTOR_CAPABILITY_FIELDS) {
    if (Object.hasOwn(capabilities, field)) ordered[field as string] = capabilities[field as string];
  }
  return ordered;
};

const CONTEXT_KEY_ORDER: ReadonlyArray<string> = [
  "providerId",
  "providerKind",
  "providerVersion",
  "setupProviderId",
  "runtimeStatus",
  "setupStatus",
  "updatedAt",
  "lastFailedStep",
  "stepProvider",
  "stepCa",
  "stepProxy",
  "stepProxyEvidence",
  "stepShell",
  "stepFileSync",
  "stepFileSyncEvidence",
  "runtimeVersion",
  "bundleVersion",
  "platform",
  "selectionSource",
  "conflictKind",
  "socketPath",
  "providerLandoStatePath",
  "runtimeRunning",
  "socketReachable",
  "ownedServiceProcess",
  "runtimePid",
  "orphanPids",
  "lastRecordedRunning",
  "lastRecordedSocketPath",
  "lastRecordedPid",
  "lastRecordedRuntimeVersion",
  "containerName",
  "image",
  "exitCode",
  "app",
  "service",
  "workerState",
  "statePath",
  "appId",
  "transport",
  "reachability",
  "endpoint",
  "containerGateway",
  "workerProviderId",
  "reason",
  "failure",
];

const orderContextKeys = (context: Readonly<Record<string, string>>): Record<string, string> =>
  orderKnownKeys(context, CONTEXT_KEY_ORDER);

const selectionEventPayload = (selection: DoctorSelectionRecord): Record<string, unknown> => ({
  providerId: selection.providerId,
  source: selection.source,
  inputs: {
    ...(selection.inputs.flag === undefined ? {} : { flag: selection.inputs.flag }),
    ...(selection.inputs.landofile === undefined ? {} : { landofile: selection.inputs.landofile }),
    ...(selection.inputs.env === undefined ? {} : { env: selection.inputs.env }),
    ...(selection.inputs.config === undefined ? {} : { config: selection.inputs.config }),
    capabilityDefault: selection.inputs.capabilityDefault,
  },
});

const checkEventPayload = (check: DoctorCheck): Record<string, unknown> => {
  const payload: Record<string, unknown> = {
    _tag: "doctor.check",
    name: check.name,
    status: check.status,
    severity: check.severity,
    providerId: check.providerId,
    providerName: check.providerName,
    providerKind: check.providerKind,
    providerVersion: check.providerVersion,
    runtime: {
      running: check.runtime.running,
      ...(check.runtime.message === undefined ? {} : { message: check.runtime.message }),
      ...(check.runtime.version === undefined ? {} : { version: check.runtime.version }),
      ...(check.runtime.oomKilled === undefined ? {} : { oomKilled: check.runtime.oomKilled }),
    },
    capabilities: orderCapabilityKeys(check.capabilities),
    context: orderContextKeys(check.context),
    solutions: check.solutions.map((solution) => ({
      kind: solution.kind,
      description: solution.description,
      ...(solution.command === undefined ? {} : { command: solution.command }),
    })),
  };
  if (check.selection !== undefined) payload.selection = selectionEventPayload(check.selection);
  return payload;
};

export interface DoctorNdjsonOptions {
  readonly now?: Date;
}

export const renderDoctorResultAsNdjson = (result: DoctorResult, options: DoctorNdjsonOptions = {}): string =>
  renderDoctorChecksAsNdjson({
    checks: result.checks,
    now: options.now,
    checkEventPayload,
  });
