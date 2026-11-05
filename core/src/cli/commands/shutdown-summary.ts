/**
 * Compact, factual shutdown details for the stop/destroy summaries.
 *
 * Everything here repeats what the daemon reported: an exit code, a reason the
 * exit state is unknown, or an explicit OOMKilled bit. Nothing infers a graceful
 * or forced shutdown from a code: 137 may be the OOM killer, an external signal,
 * or the application's own choice, and 0 is not proof of cleanup.
 */
import { DateTime, Effect } from "effect";

import { MessageWarnEvent } from "@lando/sdk/events";
import type { ServiceShutdownObservation } from "@lando/sdk/schema";

import { escapeDiagnosticText } from "../diagnostic-text";
import { publishOptionalEvent } from "./optional-event-publish";

export type ShutdownObservations = ReadonlyArray<ServiceShutdownObservation>;

type UnknownObservation = Extract<ServiceShutdownObservation, { readonly status: "unknown" }>;

const unknownReasonText = (reason: UnknownObservation["reason"]): string => {
  switch (reason) {
    case "container-absent":
      return "container absent";
    case "state-unavailable":
      return "state unavailable";
    case "not-exited":
      return "not exited";
    case "inspect-failed":
      return "inspect failed";
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
};

const statusText = (observation: ServiceShutdownObservation): string => {
  switch (observation.status) {
    case "exited":
      return observation.exitCode === undefined ? "exit code unknown" : `exit ${observation.exitCode}`;
    case "unknown":
      return unknownReasonText(observation.reason);
    default: {
      const unreachable: never = observation;
      return unreachable;
    }
  }
};

/** Daemon facts only: the exit state plus the OOMKilled bit when it was explicitly reported. */
export const shutdownDetailText = (observation: ServiceShutdownObservation): string =>
  [statusText(observation), ...(observation.oomKilled === true ? ["OOMKilled"] : [])].join(", ");

/** Attribution is only worth its width when the observations belong to more than one app. */
const spansApps = (observations: ShutdownObservations): boolean =>
  new Set(observations.map((observation) => observation.appId)).size > 1;

/**
 * Service rows for {@link teardownLine}: the stopped names in their original
 * order, each followed by its observed detail. A name observed under several
 * app identities is listed once with every fact attributed, so a repeated name
 * is never paired with the wrong app. Names without an observation stay bare
 * and observations without a stopped name stay out of the line.
 */
export const shutdownServiceRows = (
  names: ReadonlyArray<string>,
  observations: ShutdownObservations | undefined,
): ReadonlyArray<string> => {
  if (observations === undefined || observations.length === 0) return names;
  const attribute = spansApps(observations);
  const rendered = new Set<string>();
  const rows: string[] = [];
  for (const name of names) {
    const matches = observations.filter((observation) => observation.service === name);
    if (matches.length === 0) {
      rows.push(name);
      continue;
    }
    if (rendered.has(name)) continue;
    rendered.add(name);
    const details = matches.map((observation) =>
      attribute
        ? `${observation.appId}: ${shutdownDetailText(observation)}`
        : shutdownDetailText(observation),
    );
    rows.push(`${name} (${details.join("; ")})`);
  }
  return rows;
};

/**
 * Warning bodies for the two facts that deserve stderr: an explicit OOMKilled
 * report and a failed inspection. An absent container, unavailable state, or a
 * bare non-zero exit code is routine and stays in the summary line.
 */
export const shutdownWarnings = (observations: ShutdownObservations | undefined): ReadonlyArray<string> => {
  if (observations === undefined) return [];
  const attribute = spansApps(observations);
  return observations.flatMap((observation) => {
    const subject = attribute ? `${observation.service} (${observation.appId})` : String(observation.service);
    const warnings: string[] = [];
    if (observation.oomKilled === true) {
      warnings.push(`${subject}: runtime reported OOMKilled (${statusText(observation)}).`);
    }
    if (observation.status === "unknown" && observation.reason === "inspect-failed") {
      const { _tag, message, remediation } = observation.diagnostic;
      warnings.push(
        `${subject}: shutdown state could not be inspected (${_tag}): ${escapeDiagnosticText(message)} ${escapeDiagnosticText(remediation)}`,
      );
    }
    return warnings;
  });
};

/**
 * Publish the warnings through the command's event bus so they follow the
 * existing warning path: redacted once, a stderr notice for text output and a
 * `LANDO_MESSAGE_WARN` entry in the machine envelope.
 */
export const publishShutdownWarnings = Effect.fnUntraced(function* (result: {
  readonly shutdownObservations?: ShutdownObservations;
}) {
  for (const body of shutdownWarnings(result.shutdownObservations)) {
    yield* publishOptionalEvent(MessageWarnEvent.make({ body, timestamp: yield* DateTime.now }));
  }
});

/** Forward an engine teardown receipt's observations; a provider that did not observe contributes no field. */
export const receiptShutdownObservations = (receipt: {
  readonly services: ReadonlyArray<string>;
  readonly shutdownObservations?: ShutdownObservations;
}): { readonly shutdownObservations?: ShutdownObservations } =>
  receipt.shutdownObservations === undefined ? {} : { shutdownObservations: receipt.shutdownObservations };
