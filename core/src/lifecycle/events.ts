/**
 * Re-export of the public `EventService` tag. The shipped behavior lives in
 * the modules that own it:
 *
 *   - `core/src/services/event-service.ts` owns the `Effect.PubSub`-backed
 *     Live layer: the zero-subscriber short-circuit (no payload validation,
 *     `PubSub` enqueue, or dispatch when no manifest subscriber and no active
 *     dynamic consumer exist), publish-time validation of the delivering path
 *     against the closed `LandoEvent` union before the bus/history/dispatch,
 *     and the bounded redacted history buffer.
 *   - `core/src/lifecycle/subscribers.ts` owns manifest-subscriber
 *     registration-closure indexing and the §11.6 failure policy: `pre-*`
 *     errors abort the step, `post-*` errors warn unless `abortOnError`,
 *     and `cli-*` errors log at debug without changing exit codes.
 */
export { EventService } from "@lando/sdk/services";
