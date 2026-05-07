/**
 * `EventService` Live Layer — `Effect.PubSub`-backed.
 *
 * The Live implementation:
 *   1. Holds a `PubSub.PubSub<LandoEvent>` keyed by event `_tag`.
 *   2. Publishes are validated against the discriminated `LandoEvent` union
 *      *before* hitting the bus, so unknown events are rejected with
 *      `EventError` rather than reaching subscribers.
 *   3. Subscribers register through plugin manifests; core provides built-in
 *      `critical` and `late` priority subscribers; plugin subscribers default
 *      to `default`.
 *
 * Subscriber failure handling:
 *   - `pre-*` errors abort the lifecycle step with the subscriber's tagged
 *     error.
 *   - `post-*` errors are logged at warn level and do not abort by default.
 *   - `cli-*` errors are logged at debug level; they don't change exit codes.
 *   - Subscribers may opt into "abort on error" at `post-*` events via
 *     `manifest.subscribers[].abortOnError: true`.
 *
 * Status: stub.
 */
export { EventService } from "@lando/sdk/services";
