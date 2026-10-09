import type { AppPlan, EventStep, HostEvents, LandofileEvents, LandofileShape } from "@lando/sdk/schema";
import {
  HOST_EVENT_NAMES,
  type HostEventName,
  type HostEventStep,
  LANDO_HOST_EVENT_ENV,
  resolveLifecycleCommandId,
} from "@lando/sdk/schema";
import { Predicate } from "effect";

export type EventStepSource = "host" | "project";
export type CompiledEventStepStatus = "active" | "skipped" | "deduped";

export interface CompiledEventStep {
  readonly step: EventStep;
  readonly source: EventStepSource;
  readonly sourceIndex: number;
  readonly status: CompiledEventStepStatus;
  readonly skipReason?: string;
}

export type CompiledEvents = {
  readonly [name: string]: ReadonlyArray<CompiledEventStep> | undefined;
};

const compiledEventsByPlan = new WeakMap<AppPlan, CompiledEvents>();

const compareOrdinal = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const isCompiledEventStep = (value: unknown): value is CompiledEventStep =>
  Predicate.isObject(value) &&
  "step" in value &&
  (value.source === "host" || value.source === "project") &&
  typeof value.sourceIndex === "number" &&
  (value.status === "active" || value.status === "skipped" || value.status === "deduped");

const sortedCompiled = (events: CompiledEvents): CompiledEvents =>
  Object.fromEntries(
    Object.entries(events)
      .flatMap(([name, steps]) => (steps === undefined ? [] : [[name, steps] as const]))
      .sort(([left], [right]) => compareOrdinal(left, right)),
  );

/** Same stamp the planner writes onto each service: explicit primary, else `web`. */
export const planServicePrimary = (name: string, primary: boolean | undefined): boolean =>
  primary ?? name === "web";

export const stampPlanServices = (
  services: Readonly<Record<string, { readonly primary?: boolean | undefined } | undefined>>,
): Readonly<Record<string, { readonly primary?: boolean }>> =>
  Object.fromEntries(
    Object.entries(services).map(([name, service]) => [
      name,
      { primary: planServicePrimary(name, service?.primary) },
    ]),
  );

export const primaryServiceName = (
  services: Readonly<Record<string, { readonly primary?: boolean }>> | undefined,
): string | undefined => {
  if (services === undefined) return undefined;
  return Object.entries(services).find(([, service]) => service.primary === true)?.[0];
};

const commandKind = (step: EventStep): "cmd" | "task" | "command" => {
  if (typeof step === "string") return "cmd";
  if ("task" in step && step.task !== undefined) return "task";
  if ("command" in step && step.command !== undefined) return "command";
  return "cmd";
};

const stepCommandText = (step: EventStep): string => {
  if (typeof step === "string") return step;
  if ("task" in step && step.task !== undefined) return step.task;
  if ("command" in step && step.command !== undefined) return resolveLifecycleCommandId(step.command);
  if ("cmd" in step && step.cmd !== undefined) return step.cmd;
  return "";
};

const stepService = (step: EventStep, primary: string | undefined): string | undefined => {
  if (typeof step === "string") return primary;
  if (commandKind(step) === "command") return undefined;
  if ("service" in step && step.service !== undefined) return step.service;
  return primary;
};

export const canonicalEventStepKey = (step: EventStep, primary: string | undefined): string => {
  const kind = commandKind(step);
  const service = stepService(step, primary) ?? "";
  return `${kind}:${stepCommandText(step)}:service:${service}`;
};

const asEventStep = (step: HostEventStep): EventStep => step;

const compileHostStep = (input: {
  readonly step: HostEventStep;
  readonly sourceIndex: number;
  readonly primary: string | undefined;
  readonly serviceNames: ReadonlySet<string>;
  readonly projectKeys: ReadonlySet<string>;
  readonly skipHostEvents: boolean;
}): CompiledEventStep => {
  const step = asEventStep(input.step);
  if (input.skipHostEvents) {
    return {
      step,
      source: "host",
      sourceIndex: input.sourceIndex,
      status: "skipped",
      skipReason: `${LANDO_HOST_EVENT_ENV}=1`,
    };
  }
  if (input.projectKeys.has(canonicalEventStepKey(step, input.primary))) {
    return { step, source: "host", sourceIndex: input.sourceIndex, status: "deduped" };
  }
  const service = stepService(step, input.primary);
  if (service === ":host" || commandKind(step) === "command") {
    return { step, source: "host", sourceIndex: input.sourceIndex, status: "active" };
  }
  if (service === undefined || !input.serviceNames.has(service)) {
    const reason = service === undefined ? "no primary service" : `service ${service} is not in the plan`;
    return { step, source: "host", sourceIndex: input.sourceIndex, status: "skipped", skipReason: reason };
  }
  return { step, source: "host", sourceIndex: input.sourceIndex, status: "active" };
};

const compileProjectStep = (step: EventStep, sourceIndex: number): CompiledEventStep => ({
  step,
  source: "project",
  sourceIndex,
  status: "active",
});

const landofileToCompiled = (events: LandofileEvents): CompiledEvents =>
  Object.fromEntries(
    Object.entries(events).flatMap(([name, steps]) =>
      steps === undefined
        ? []
        : [[name, steps.map((step, sourceIndex) => compileProjectStep(step, sourceIndex))] as const],
    ),
  );

export const compileEffectiveEvents = (input: {
  readonly landofile: Pick<LandofileShape, "events">;
  readonly hostEvents?: HostEvents;
  readonly services?: Readonly<Record<string, { readonly primary?: boolean }>>;
  readonly skipHostEvents?: boolean;
}): CompiledEvents => {
  const primary = primaryServiceName(input.services);
  const serviceNames = new Set(Object.keys(input.services ?? {}));
  const skipHostEvents = input.skipHostEvents === true;
  const names = new Set<string>([
    ...Object.keys(input.landofile.events ?? {}),
    ...HOST_EVENT_NAMES.filter((name) => (input.hostEvents?.[name] ?? []).length > 0),
  ]);
  const compiled: Record<string, ReadonlyArray<CompiledEventStep>> = {};
  for (const name of names) {
    const projectSteps = input.landofile.events?.[name as keyof LandofileEvents] ?? [];
    const projectKeys = new Set(projectSteps.map((step) => canonicalEventStepKey(step, primary)));
    const hostSteps = HOST_EVENT_NAMES.includes(name as HostEventName)
      ? (input.hostEvents?.[name as HostEventName] ?? []).map((step, sourceIndex) =>
          compileHostStep({
            step,
            sourceIndex,
            primary,
            serviceNames,
            projectKeys,
            skipHostEvents,
          }),
        )
      : [];
    compiled[name] = [
      ...hostSteps,
      ...projectSteps.map((step, sourceIndex) => compileProjectStep(step, sourceIndex)),
    ];
  }
  return sortedCompiled(compiled);
};

export const runnableCompiledSteps = (
  steps: ReadonlyArray<CompiledEventStep> | undefined,
): ReadonlyArray<CompiledEventStep> => (steps ?? []).filter((step) => step.status === "active");

export const eventStepsFromCompiled = (events: CompiledEvents): LandofileEvents =>
  Object.fromEntries(
    Object.entries(events).flatMap(([name, steps]) => {
      const runnable = runnableCompiledSteps(steps).map((step) => step.step);
      return runnable.length === 0 ? [] : [[name, runnable] as const];
    }),
  );

const normalizeAttached = (events: LandofileEvents | CompiledEvents): CompiledEvents => {
  const first = Object.values(events).find((steps) => steps !== undefined && steps.length > 0)?.[0];
  return first !== undefined && isCompiledEventStep(first)
    ? (events as CompiledEvents)
    : landofileToCompiled(events as LandofileEvents);
};

export const attachEffectiveEvents = (plan: AppPlan, events: LandofileEvents | CompiledEvents): AppPlan => {
  compiledEventsByPlan.set(plan, sortedCompiled(normalizeAttached(events)));
  return plan;
};

export const compiledEventsForPlan = (plan: AppPlan): CompiledEvents | undefined =>
  compiledEventsByPlan.get(plan);

export const effectiveEventsForPlan = (plan: AppPlan): LandofileEvents | undefined => {
  const compiled = compiledEventsByPlan.get(plan);
  return compiled === undefined ? undefined : eventStepsFromCompiled(compiled);
};

export const hostEventStatusesForApp = (
  compiled: CompiledEvents,
): ReadonlyArray<{
  readonly event: string;
  readonly index: number;
  readonly step: EventStep;
  readonly status: CompiledEventStepStatus;
  readonly reason?: string;
}> =>
  HOST_EVENT_NAMES.flatMap((event) =>
    (compiled[event] ?? [])
      .filter((step) => step.source === "host")
      .map((step) => ({
        event,
        index: step.sourceIndex,
        step: step.step,
        status: step.status,
        ...(step.skipReason === undefined ? {} : { reason: step.skipReason }),
      })),
  );
