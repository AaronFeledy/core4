/**
 * OCLIF topic configuration.
 *
 * Topic separators: both `:` and ` ` are accepted (`flexibleTaxonomy: true`).
 * `lando plugin:add` and `lando plugin add` are equivalent.
 *
 * Topics: `plugin:`, `provider:`, etc.
 *
 * The actual `topics` field lives in `package.json#oclif.topics`. This file
 * defines the topic *metadata* (descriptions, hidden flags) that gets
 * baked into the manifest at build time.
 */

export const TOPICS = {
  plugin: {
    description: "Manage Lando plugins (install, remove, login, logout).",
  },
  provider: {
    description: "Manage runtime providers (setup, status).",
  },
} as const satisfies Record<string, { description: string; hidden?: boolean }>;
