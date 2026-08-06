export const COMMAND_TOPICS = {
  app: { description: "Operate on the current Lando app." },
  "app:cache": { description: "App plan, tooling graph, and command index cache." },
  "app:config": { description: "Read/write the current app's Landofile." },
  "app:includes": { description: "Manage the app's includes lockfile." },
  apps: { description: "Discover and operate across Lando apps on the host." },
  "apps:scratch": { description: "Short-lived scratch apps." },
  meta: { description: "Operate on Lando itself: config, plugins, host setup." },
  "meta:events": { description: "Lifecycle event diagnostics." },
  "meta:global": { description: "Manage the host-level global Lando app." },
  "meta:plugin": { description: "Plugin install, remove, and authoring commands." },
  "meta:recipes": { description: "Inspect canonical recipes shipped with Lando." },
} as const satisfies Record<string, { readonly description: string; readonly hidden?: boolean }>;
