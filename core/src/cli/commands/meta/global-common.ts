import { includeAvailableDependencies } from "@lando/engine/operations/ensure-global-services";
import { ToolingExecError } from "@lando/sdk/errors";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import { Effect } from "effect";
import { serviceStateRow } from "../service-summary";
import type { GlobalStartedService } from "./global-start";

export const globalAppRef = (plan: Pick<AppPlan, "id" | "root">): AppRef => ({
  kind: "global",
  id: plan.id,
  root: plan.root,
});

export const renderGlobalServiceRow = (service: GlobalStartedService): string =>
  serviceStateRow(service.name, service.state, service.endpoints);

type GlobalServiceNames = Readonly<Record<string, { readonly name: string }>>;
type GlobalSelectionCommand = "meta:global:start" | "meta:global:info" | "meta:global:status";

export const availableGlobalServiceList = (services: GlobalServiceNames): string =>
  Object.values(services)
    .map((service) => String(service.name))
    .sort()
    .join(", ");

export const unknownGlobalServiceError = ({
  commandId,
  requested,
  services,
  withRemediation,
}: {
  readonly commandId: GlobalSelectionCommand;
  readonly requested: string;
  readonly services: GlobalServiceNames;
  readonly withRemediation: boolean;
}): ToolingExecError => {
  const list = availableGlobalServiceList(services);
  const first = list.split(", ")[0];
  return new ToolingExecError({
    message:
      list.length === 0
        ? `${commandId}: service ${requested} is not in the global app plan.`
        : `${commandId}: service ${requested} is not in the global app plan (available: ${list}).`,
    tool: commandId,
    ...(withRemediation && first !== undefined && first.length > 0
      ? { remediation: `Example: lando ${commandId.slice("meta:".length)} --service ${first}` }
      : {}),
  });
};

export const selectGlobalServices = <
  S extends {
    readonly name: string;
    readonly dependsOn: ReadonlyArray<{ readonly service: string }>;
  },
>({
  commandId,
  requested,
  services,
  expandDependencies,
}: {
  readonly commandId: GlobalSelectionCommand;
  readonly requested: ReadonlyArray<string> | undefined;
  readonly services: Readonly<Record<string, S>>;
  readonly expandDependencies: boolean;
}): Effect.Effect<ReadonlyArray<S>, ToolingExecError> => {
  const available = Object.values(services);
  if (requested === undefined || requested.length === 0) return Effect.succeed(available);
  const names = new Set(available.map((service) => String(service.name)));
  const missing = requested.find((name) => !names.has(name));
  if (missing !== undefined)
    return Effect.fail(
      unknownGlobalServiceError({
        commandId,
        requested: missing,
        services,
        withRemediation: commandId !== "meta:global:info",
      }),
    );
  const selected = expandDependencies
    ? includeAvailableDependencies(requested, available)
    : new Set(requested);
  return Effect.succeed(available.filter((service) => selected.has(String(service.name))));
};
