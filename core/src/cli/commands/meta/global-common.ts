import { includeAvailableDependencies } from "@lando/engine/operations/ensure-global-services";
import { unknownPlanServiceError } from "@lando/engine/operations/unknown-service";
import type { ToolingExecError } from "@lando/sdk/errors";
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
export const withGlobalLifecycleEvents = Effect.fnUntraced(function* <A, E, R, PreE, PreR, PostE, PostR>(
  events: {
    readonly pre: () => Effect.Effect<unknown, PreE, PreR>;
    readonly post: (result: A) => Effect.Effect<unknown, PostE, PostR>;
  },
  body: Effect.Effect<A, E, R>,
) {
  yield* events.pre();
  const result = yield* body;
  yield* events.post(result);
  return result;
});

type GlobalSelectionCommand = "meta:global:start" | "meta:global:info" | "meta:global:status";

export { availableServiceList as availableGlobalServiceList } from "@lando/engine/operations/unknown-service";

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
}): ToolingExecError =>
  unknownPlanServiceError({
    prefix: commandId,
    tool: commandId,
    requested,
    services,
    planLabel: "global app plan",
    remediation: (first) =>
      withRemediation ? `Example: lando ${commandId.slice("meta:".length)} --service ${first}` : undefined,
  });

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
