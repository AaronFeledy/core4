export type SidebarEntry = {
  readonly label?: string;
  readonly slug?: string;
  readonly collapsed?: boolean;
  readonly autogenerate?: { readonly directory: string; readonly collapsed?: boolean };
  readonly items?: readonly SidebarEntry[];
};

export const sidebar = [
  { label: "Install the Alpha", slug: "alpha-install-and-bug-reports" },
  {
    label: "Guides",
    collapsed: true,
    items: [
      {
        label: "Tutorial",
        collapsed: true,
        items: [
          { label: "App lifecycle", slug: "guides/tutorial/app-lifecycle" },
          { label: "From Lando 3", slug: "guides/tutorial/from-lando-3" },
          { label: "Node and Postgres", slug: "guides/node-postgres" },
        ],
      },
      {
        label: "Setup",
        collapsed: true,
        items: [
          { label: "Pick a container provider", slug: "guides/setup/provider-selection" },
          { label: "Run lando setup", slug: "guides/setup/provider-auto-setup" },
          { label: "Check first-run readiness", slug: "guides/setup/first-run-readiness" },
          { label: "Exclude paths from file sync", slug: "guides/setup/file-sync-excludes" },
          { label: "Uninstall and purge", slug: "guides/setup/uninstall-and-purge" },
        ],
      },
      {
        label: "Install",
        collapsed: true,
        items: [
          { label: "Install from a GitHub release", slug: "guides/install/github-releases" },
          { label: "POSIX installer", slug: "guides/install/posix-installer" },
          { label: "Install Lando on WSL", slug: "guides/install/wsl" },
        ],
      },
      {
        label: "Services",
        collapsed: true,
        items: [{ autogenerate: { directory: "guides/services", collapsed: true } }],
      },
      {
        label: "Recipe guides",
        collapsed: true,
        items: [
          { label: "LAMP stack variants", slug: "guides/recipes/lamp-stack-variants" },
          { label: "Drupal stack overrides", slug: "guides/recipes/drupal-stack-overrides" },
          { label: "Drupal multisite", slug: "guides/recipes/drupal-multisite" },
        ],
      },
      {
        label: "Tooling",
        collapsed: true,
        items: [{ autogenerate: { directory: "guides/tooling", collapsed: true } }],
      },
      {
        label: "Landofile",
        collapsed: true,
        items: [{ autogenerate: { directory: "guides/landofile", collapsed: true } }],
      },
      {
        label: "Config",
        collapsed: true,
        items: [{ autogenerate: { directory: "guides/config", collapsed: true } }],
      },
      {
        label: "CLI",
        collapsed: true,
        items: [
          { label: "Everyday commands", slug: "guides/cli/everyday-commands" },
          { label: "Start a scratch app from a recipe", slug: "guides/scratch/scratch-from-recipe" },
          { label: "Open a shell in a service", slug: "guides/cli/ssh" },
          { label: "Run commands inside a service", slug: "guides/cli/exec" },
          { label: "Init from a remote source", slug: "guides/cli/init-from-remote" },
          { label: "Interactive prompts", slug: "guides/cli/interactive-prompts" },
          { label: "Power off every app", slug: "guides/cli/poweroff" },
          { label: "Service logs", slug: "guides/cli/service-logs" },
        ],
      },
      {
        label: "Subsystems",
        collapsed: true,
        items: [
          { label: "Use the Traefik proxy", slug: "guides/subsystems/proxy-traefik" },
          { label: "Run lando doctor", slug: "guides/subsystems/doctor-walkthrough" },
          { label: "Reach an app from another device", slug: "guides/subsystems/external-access" },
          { label: "Trust local HTTPS certificates", slug: "guides/subsystems/certificates-mkcert" },
          { label: "Resolve lndo.site on this machine", slug: "guides/subsystems/host-proxy" },
        ],
      },
      {
        label: "Plugins",
        collapsed: true,
        items: [
          { label: "Add a plugin", slug: "guides/plugins/install-from-npm" },
          { label: "Manage plugin trust", slug: "guides/plugins/trust-management" },
        ],
      },
      {
        label: "Telemetry",
        collapsed: true,
        items: [{ label: "Disable telemetry", slug: "guides/telemetry/disable-telemetry" }],
      },
      {
        label: "Agents",
        collapsed: true,
        items: [
          { label: "Drive Lando through MCP", slug: "guides/agent-native/mcp" },
          { label: "Inspect a running app", slug: "guides/agent-native/in-container-context" },
        ],
      },
    ],
  },
  {
    label: "Recipes",
    items: [
      { label: "Drupal", slug: "recipes/drupal" },
      { label: "Drupal CMS", slug: "recipes/drupal-cms" },
      { label: "LAMP", slug: "recipes/lamp" },
      { label: "LEMP", slug: "recipes/lemp" },
      { label: "WordPress", slug: "recipes/wordpress" },
    ],
  },
  {
    label: "Reference",
    collapsed: true,
    items: [
      { autogenerate: { directory: "reference", collapsed: true } },
      { label: "PHP base images", slug: "php-base-images" },
    ],
  },
  {
    label: "Embedding",
    items: [{ label: "Embed @lando/core", slug: "embedding" }],
  },
  {
    label: "Telemetry",
    items: [
      { label: "Events", slug: "telemetry/events" },
      { label: "Retention", slug: "telemetry/retention" },
    ],
  },
  {
    label: "Contributing",
    items: [
      { label: "CI", slug: "contributing/ci" },
      { label: "Release", slug: "contributing/release" },
      { label: "Decisions", slug: "contributing/decisions" },
    ],
  },
] as const satisfies readonly SidebarEntry[];
