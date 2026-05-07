/**
 * Event-payload schemas — re-exported from `@lando/sdk/events`.
 *
 * Every event payload is an Effect Schema. Subscribers receive a decoded,
 * validated payload. Subscribers return `Effect.Effect<void, E>`; failures
 * bubble up through the event service and (depending on the event) either
 * abort the lifecycle step or are reported as warnings.
 */
export * from "@lando/sdk/events";
