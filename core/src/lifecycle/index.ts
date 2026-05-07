/**
 * `@lando/core/events` — re-exported from `dist/lifecycle/index.js`
 * (this is the entry point that backs the `./events` export).
 *
 * Re-exports:
 *   - `EventService` tag (from `./events.ts`).
 *   - Every event payload schema (from `@lando/sdk/events` via `./schema.ts`).
 *   - Subscriber priority bands and types (from `@lando/sdk/events`).
 */

export * from "./events.ts";
export * from "./schema.ts";
export * from "./subscribers.ts";
