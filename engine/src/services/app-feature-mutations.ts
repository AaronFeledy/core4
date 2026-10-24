import { canonicalJson } from "@lando/sdk/digest";
import { AppFeatureMutationConflictError } from "@lando/sdk/errors";
import type { AppFeatureContext, AppFeatureServiceMutators } from "@lando/sdk/services";
import {
  type AppFeatureApplicationInput,
  type AppFeatureServiceDraft,
  type OrderedAppFeature,
  viewOf,
} from "./app-feature-types.ts";

type WriteLedger = Map<string, unknown>;
const sameMutationValue = (a: unknown, b: unknown): boolean =>
  a === undefined || b === undefined ? a === b : canonicalJson(a) === canonicalJson(b);
const recordWrite = (
  ledger: WriteLedger,
  write: {
    readonly feature: string;
    readonly serviceName: string;
    readonly field: string;
    readonly key?: string;
    readonly value: unknown;
  },
): void => {
  const ledgerKey = `${write.serviceName}\u0000${write.field}${write.key === undefined ? "" : `\u0000${write.key}`}`;
  if (ledger.has(ledgerKey)) {
    const existing = ledger.get(ledgerKey);
    const equal =
      write.key === undefined ? sameMutationValue(existing, write.value) : existing === write.value;
    if (!equal)
      throw new AppFeatureMutationConflictError({
        message: `App feature ${write.feature} wrote a conflicting ${write.field} value for service ${write.serviceName}`,
        feature: write.feature,
        service: write.serviceName,
        field: write.key === undefined ? write.field : `${write.field}.${write.key}`,
        existing,
        incoming: write.value,
        remediation: "Resolve the conflicting app-feature mutations so they agree on the value.",
      });
  }
  ledger.set(ledgerKey, write.value);
};
const makeMutators = (
  draft: AppFeatureServiceDraft,
  feature: string,
  ledger: WriteLedger,
): AppFeatureServiceMutators => ({
  service: viewOf(draft),
  addEnv: (name, value) => {
    recordWrite(ledger, { feature, serviceName: draft.serviceName, field: "environment", key: name, value });
    draft.environment[name] = value;
  },
  addMount: (mount) => {
    draft.mounts.push({ ...mount });
  },
  setAppMount: (mount) => {
    recordWrite(ledger, { feature, serviceName: draft.serviceName, field: "appMount", value: mount });
    draft.appMount = { ...mount };
  },
  addBuildStep: (step) => {
    draft.buildSteps.push({ ...step });
  },
  addStorage: (storage) => {
    draft.storage.push({ ...storage });
  },
  addDependency: (dependency) => {
    draft.dependsOn.push({ ...dependency });
  },
  addHostAlias: (alias) => {
    draft.hostAliases.push({ ...alias });
  },
  setHealthcheck: (healthcheck) => {
    recordWrite(ledger, {
      feature,
      serviceName: draft.serviceName,
      field: "healthcheck",
      value: healthcheck,
    });
    draft.healthcheck = { ...healthcheck };
  },
  setReadiness: (readiness) => {
    recordWrite(ledger, { feature, serviceName: draft.serviceName, field: "readiness", value: readiness });
    draft.readiness = { ...readiness };
  },
  setCerts: (certs) => {
    recordWrite(ledger, { feature, serviceName: draft.serviceName, field: "certs", value: certs });
    draft.certs = { ...certs };
  },
  setEntrypoint: (entrypoint) => {
    recordWrite(ledger, { feature, serviceName: draft.serviceName, field: "entrypoint", value: entrypoint });
    draft.entrypoint = Array.isArray(entrypoint) ? [...entrypoint] : entrypoint;
  },
  setCommand: (command) => {
    recordWrite(ledger, { feature, serviceName: draft.serviceName, field: "command", value: command });
    draft.command = Array.isArray(command) ? [...command] : command;
  },
  setArtifact: (artifact) => {
    recordWrite(ledger, { feature, serviceName: draft.serviceName, field: "artifact", value: artifact });
    draft.artifact = { ...artifact };
  },
  setUser: (user) => {
    recordWrite(ledger, { feature, serviceName: draft.serviceName, field: "user", value: user });
    draft.user = user;
  },
  setWorkingDirectory: (path) => {
    recordWrite(ledger, { feature, serviceName: draft.serviceName, field: "workingDirectory", value: path });
    draft.workingDirectory = path;
  },
});
export const makeAppFeatureContext = (input: {
  readonly feature: OrderedAppFeature;
  readonly composition: AppFeatureApplicationInput;
  readonly config: Readonly<Record<string, unknown>>;
  readonly selectedNames: readonly string[];
  readonly ledger: WriteLedger;
}): AppFeatureContext => {
  const byName = new Map(input.composition.services.map((service) => [service.serviceName, service]));
  const selected = input.selectedNames.map((name) => {
    const draft = byName.get(name);
    if (draft === undefined)
      throw new AppFeatureMutationConflictError({
        feature: input.feature.id,
        service: name,
        field: "selectedServices",
        message: `Prepared app feature ${input.feature.id} selected missing service ${name}.`,
        remediation: "Preserve every prepared service through app-feature application.",
      });
    return draft;
  });
  const selectedSet = new Set(input.selectedNames);
  return {
    featureId: input.feature.definition.id,
    appName: input.composition.appName,
    appRoot: input.composition.appRoot,
    config: input.config,
    selected: selected.map(viewOf),
    forEachSelected: (mutate) => {
      for (const draft of selected) mutate(makeMutators(draft, input.feature.definition.id, input.ledger));
    },
    select: (name) => {
      if (!selectedSet.has(name)) return undefined;
      const draft = byName.get(name);
      return draft === undefined ? undefined : makeMutators(draft, input.feature.definition.id, input.ledger);
    },
  };
};
