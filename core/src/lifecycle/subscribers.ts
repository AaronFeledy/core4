/**
 * Plugin subscriber registry.
 *
 * Subscriber registration is declarative (manifest + subscriber module
 * path). Runtime registration outside declared plugin entry points is not
 * a public extension mechanism. The internal core code may register inline
 * subscribers, but plugins always go through the manifest.
 *
 * Status: stub.
 */
import type { Effect } from "effect";

import type { EventError } from "@lando/sdk/errors";
import type { SubscriberPriorityBand } from "@lando/sdk/events";

export interface SubscriberRegistration {
  readonly event: string;
  readonly scope: "lando" | "app" | "provider" | "tooling" | "cli";
  /** Numeric priority. Lower runs first. See `SubscriberPriority` bands. */
  readonly priority: number;
  /** Optional declared priority band — for documentation and validation. */
  readonly band?: SubscriberPriorityBand;
  /** Module path to import lazily on first delivery. */
  readonly module: string;
  /** Whether subscriber errors at `post-*` events abort the step. */
  readonly abortOnError?: boolean;
  /** Plugin name that contributed this subscriber (for diagnostics). */
  readonly pluginName: string;
}

/**
 * `Subscriber` — the resolved handler imported from a plugin's subscriber
 * module. The function receives a typed event payload and returns an
 * `Effect`. Failures are bridged to `EventError`.
 */
export type Subscriber<E> = (event: E) => Effect.Effect<void, EventError>;
