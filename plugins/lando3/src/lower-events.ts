/**
 * Lando 3 `events:` as Lando 4 event steps.
 *
 * Lando 4 validates event names against its lifecycle and the app's
 * effective tooling, so an event Lando 3 would never have fired is dropped
 * rather than emitted. Every step names its service: a bare Lando 3 command
 * ran in the bracketed task's service, or for lifecycle events in the app's
 * default service (first primary API-4 service, first API-3 service, first
 * Compose service, then `appserver`).
 */
import { isLegacyTagged } from "@lando/sdk/landofile";
import type { LoweredTask } from "./lower-tooling.ts";
import { type V4Wire, isPlainObject } from "./lowering-contract.ts";
import { type Report, lowerText } from "./lowering-report.ts";

const LIFECYCLE = new Set(
  ["init", "start", "stop", "restart", "rebuild", "destroy"].flatMap((event) => [
    `pre-${event}`,
    `post-${event}`,
  ]),
);

export interface EventLoweringInput {
  readonly services: unknown;
  /** Services a recipe contributes; Lando 3 put them ahead of authored services. */
  readonly recipeServices: ReadonlyArray<string>;
  /** Tasks converted from this document. */
  readonly tasks: ReadonlyMap<string, LoweredTask>;
  /** Tasks another layer or the recipe already defines. */
  readonly inheritedTools: ReadonlySet<string>;
}

export const defaultEventService = (services: unknown, recipeServices: ReadonlyArray<string>): string => {
  const authored = isPlainObject(services)
    ? Object.entries(services).filter((entry): entry is [string, Record<string, unknown>] =>
        isPlainObject(entry[1]),
      )
    : [];
  const primary = authored.find(([, service]) => service.api === 4 && service.primary === true);
  if (primary !== undefined) return primary[0];
  const recipe = recipeServices.includes("appserver") ? "appserver" : recipeServices[0];
  if (recipe !== undefined) return recipe;
  const api3 = authored.find(([, service]) => (service.api ?? 3) === 3 && service.type !== "compose");
  if (api3 !== undefined) return api3[0];
  const compose = authored.find(([, service]) => (service.api ?? 3) === 3 && service.type === "compose");
  return compose?.[0] ?? "appserver";
};

const commandText = (value: unknown, path: ReadonlyArray<string | number>, report: Report) =>
  lowerText(
    Array.isArray(value) && value.every((part) => typeof part === "string") ? value.join(" ") : value,
    path,
    report,
  );

export const lowerEvents = (value: unknown, input: EventLoweringInput, report: Report): V4Wire => {
  const events: Record<string, unknown> = {};
  if (!isPlainObject(value)) return events;
  const appDefault = defaultEventService(input.services, input.recipeServices);
  for (const [event, steps] of Object.entries(value)) {
    const path = ["events", event];
    const tool = /^(?:pre|post)-(.+)$/u.exec(event)?.[1];
    const lifecycle = LIFECYCLE.has(event);
    const bracketed =
      !lifecycle && tool !== undefined && (input.tasks.has(tool) || input.inheritedTools.has(tool));
    if (!lifecycle && !bracketed) {
      report(
        "dropped",
        path,
        `${event} is not a Lando 4 lifecycle event and brackets no tooling task in this app, so Lando 4 would reject it.`,
        "Move these commands into a tooling task, or attach them to a lifecycle event.",
      );
      continue;
    }
    if (!Array.isArray(steps)) {
      report(
        "unsupported",
        path,
        "An event must be a list of commands.",
        "Rewrite the event as a list before converting.",
      );
      continue;
    }
    if (bracketed || tool === "restart") {
      report(
        "rewritten",
        path,
        bracketed ? `${event} runs around the ${tool} tooling task.` : `${event} runs around lando restart.`,
        "Review the event's commands and their order.",
      );
    }
    const fallback = (bracketed ? input.tasks.get(tool)?.service : undefined) ?? appDefault;
    const lowered: Record<string, unknown>[] = [];
    steps.forEach((step: unknown, index) => {
      const stepPath = [...path, index];
      if (isPlainObject(step) && !isLegacyTagged(step)) {
        const [[service, command] = [], ...extra] = Object.entries(step);
        const cmd = service === undefined ? undefined : commandText(command, [...stepPath, service], report);
        if (service === undefined || typeof cmd !== "string") {
          if (cmd !== null) {
            report(
              "unsupported",
              stepPath,
              "A {service: command} step must map one service to one command.",
              "Rewrite the step as one command string before converting.",
            );
          }
          return;
        }
        for (const [ignored] of extra) {
          report(
            "dropped",
            [...stepPath, ignored],
            "Lando 3 ran only the first service of a {service: command} step and ignored this one.",
            "Add a separate step for this service if it should run.",
          );
        }
        lowered.push({ cmd, service });
        return;
      }
      const cmd = lowerText(step, stepPath, report);
      if (typeof cmd !== "string") {
        if (cmd === undefined) {
          report(
            "unsupported",
            stepPath,
            "An event step must be a command string or a {service: command} entry.",
            "Rewrite the step as a command string before converting.",
          );
        }
        return;
      }
      lowered.push({ cmd, service: fallback });
      report(
        "generated",
        stepPath,
        `Lando 3 ran this command in ${fallback}; the step now names that service.`,
        "Review the service this step runs in.",
      );
    });
    if (lowered.length > 0) events[event] = lowered;
  }
  return events;
};
