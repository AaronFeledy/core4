import { DateTime, Effect } from "effect";

import { MessageWarnEvent } from "@lando/sdk/events";
import type { AppPlan } from "@lando/sdk/schema";
import type { EventServiceShape, ScanEndpoint, UrlScannerShape } from "@lando/sdk/services";

import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";

export interface PostStartScanInput {
  readonly scanner: UrlScannerShape;
  readonly plan: AppPlan;
  readonly events: Pick<EventServiceShape, "publish">;
}

const now = () => DateTime.unsafeMake(new Date().toISOString());

const resolveRedactor = Effect.gen(function* () {
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (redaction._tag === "None")
    return createStandaloneRedactor("secrets", { sourceEnv: { ...process.env } });
  return yield* redaction.value.forProfile("secrets", { sourceEnv: { ...process.env } });
});

// A scanner that predates the probe verdicts reports reachability only, so fall
// back to it rather than treating a missing outcome as a failure.
const passed = (endpoint: ScanEndpoint): boolean =>
  endpoint.outcome === undefined ? endpoint.reachable : endpoint.outcome === "green";

const endpointWarning = (endpoint: ScanEndpoint): string => {
  const verdict = endpoint.outcome === "yellow" ? "answered with an unaccepted status" : "did not answer";
  const detail = endpoint.detail === undefined ? "" : `: ${endpoint.detail}`;
  return `URL scan for service ${endpoint.service} at ${endpoint.url} ${verdict}${detail}.`;
};

/**
 * Probes the app's published URLs once the app is up. Every verdict other than
 * a pass is a warning: the app is already running, so a scan result never
 * decides whether start succeeded. The scanner redacts its own detail, and the
 * warning body is redacted again before it reaches the event bus.
 */
export const runPostStartScan = (input: PostStartScanInput): Effect.Effect<void> =>
  Effect.gen(function* () {
    const redactor = yield* resolveRedactor;
    const warn = (body: string) =>
      input.events.publish(MessageWarnEvent.make({ body: redactor.redactString(body), timestamp: now() }));

    const scanned = yield* Effect.either(input.scanner.scan(input.plan.id, { plan: input.plan }));
    if (scanned._tag === "Left") {
      yield* warn(`URL scan did not run: ${scanned.left.message}`);
      return;
    }

    yield* Effect.forEach(
      scanned.right.endpoints.filter((endpoint) => !passed(endpoint)),
      (endpoint) => warn(endpointWarning(endpoint)),
      { discard: true },
    );
  }).pipe(Effect.catchAllCause(() => Effect.void));
