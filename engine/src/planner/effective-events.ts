import type {
  AppPlan,
  EventStep,
  EventStepPlan,
  EventStepStatus,
  EventsPlan,
  HostEvents,
  LandofileEvents,
  LandofileShape,
} from "@lando/sdk/schema";
import {
  HOST_EVENT_NAMES,
  type HostEventName,
  type HostEventStep,
  LANDO_HOST_EVENT_ENV,
  resolveLifecycleCommandId,
} from "@lando/sdk/schema";

const compareOrdinal = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const sortedCompiled = (events: EventsPlan): EventsPlan =>
  Object.fromEntries(Object.entries(events).sort(([left], [right]) => compareOrdinal(left, right)));

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
  const modifiers =
    typeof step === "string"
      ? []
      : Object.entries(step)
          .filter(([key]) => key !== "cmd" && key !== "command" && key !== "service")
          .sort(([left], [right]) => compareOrdinal(left, right));
  return JSON.stringify([kind, stepCommandText(step), service, modifiers]);
};

const compileHostStep = (input: {
  readonly step: HostEventStep;
  readonly sourceIndex: number;
  readonly primary: string | undefined;
  readonly serviceNames: ReadonlySet<string>;
  readonly projectKeys: ReadonlySet<string>;
  readonly skipHostEvents: boolean;
}): EventStepPlan => {
  const step = input.step;
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

const compileProjectStep = (step: EventStep, sourceIndex: number): EventStepPlan => ({
  step,
  source: "project",
  sourceIndex,
  status: "active",
});

const projectEventsPlan = (events: LandofileEvents): EventsPlan =>
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
}): EventsPlan => {
  const primary = primaryServiceName(input.services);
  const serviceNames = new Set(Object.keys(input.services ?? {}));
  const skipHostEvents = input.skipHostEvents === true;
  const names = new Set<string>([
    ...Object.keys(input.landofile.events ?? {}),
    ...HOST_EVENT_NAMES.filter((name) => (input.hostEvents?.[name] ?? []).length > 0),
  ]);
  const compiled: Record<string, ReadonlyArray<EventStepPlan>> = {};
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
  steps: ReadonlyArray<EventStepPlan> | undefined,
): ReadonlyArray<EventStepPlan> => (steps ?? []).filter((step) => step.status === "active");

/** The runnable steps of a compiled plan, in Landofile `events:` shape. */
export const eventStepsFromCompiled = (events: EventsPlan): LandofileEvents =>
  Object.fromEntries(
    Object.entries(events).flatMap(([name, steps]) => {
      const runnable = runnableCompiledSteps(steps).map((step) => step.step);
      return runnable.length === 0 ? [] : [[name, runnable] as const];
    }),
  );

export const effectiveEventsForPlan = (plan: AppPlan): LandofileEvents | undefined =>
  plan.events === undefined ? undefined : eventStepsFromCompiled(plan.events);

/** Return the plan carrying `events`; the plan is a value, so later spreads keep them. */
export const withEventsPlan = (plan: AppPlan, events: EventsPlan): AppPlan => ({
  ...plan,
  events: sortedCompiled(events),
});

/** `withEventsPlan` for plans built without host events: tests and hand-built plans. */
export const withProjectEvents = (plan: AppPlan, events: LandofileEvents): AppPlan =>
  withEventsPlan(plan, projectEventsPlan(events));

export const hostEventStatusesForApp = (
  compiled: EventsPlan,
): ReadonlyArray<{
  readonly event: string;
  readonly index: number;
  readonly step: EventStep;
  readonly status: EventStepStatus;
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
