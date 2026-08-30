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
          { label: "Use system Podman on Linux", slug: "guides/setup/provider-podman-linux" },
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
          { label: "Extend a recipe", slug: "guides/recipes/extending-recipes" },
          { label: "Declare a recipe runs allowlist", slug: "guides/recipes/authoring-runs-allowlist" },
          { label: "Declare a recipe fetch allowlist", slug: "guides/recipes/authoring-fetch-allowlist" },
          { label: "Write a programmatic recipe", slug: "guides/recipes/programmatic-recipe" },
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
          { label: "Refresh a stale app cache", slug: "guides/cli/cache-refresh" },
          { label: "See more CLI output", slug: "guides/cli/verbosity-and-debug" },
          { label: "Start a scratch app from a recipe", slug: "guides/scratch/scratch-from-recipe" },
          { label: "Run a command in a disposable scratch", slug: "guides/scratch/disposable-tool-runner" },
          { label: "Fork the current app into a scratch", slug: "guides/scratch/fork-existing-app" },
          { label: "List scratch apps", slug: "guides/scratch/list-and-info" },
          {
            label: "Mount the working directory into a scratch",
            slug: "guides/scratch/mount-and-share-flags",
          },
          { label: "Reap orphaned scratch apps", slug: "guides/scratch/scratch-gc" },
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
          { label: "See plugin discovery scopes", slug: "guides/plugins/discovery-scopes" },
          { label: "Manage plugin trust", slug: "guides/plugins/trust-management" },
          { label: "Scaffold a plugin", slug: "guides/plugins/authoring-new-plugin" },
          { label: "Test and build a plugin", slug: "guides/plugins/test-and-build-plugin" },
          { label: "Link a local plugin", slug: "guides/plugins/link-local-plugin" },
          { label: "Publish a plugin", slug: "guides/plugins/publish-plugin" },
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
      { label: "Backdrop", slug: "recipes/backdrop" },
      { label: "Drupal", slug: "recipes/drupal" },
      { label: "Drupal CMS", slug: "recipes/drupal-cms" },
      { label: "Joomla", slug: "recipes/joomla" },
      { label: "LAMP", slug: "recipes/lamp" },
      { label: "Laravel", slug: "recipes/laravel" },
      { label: "LEMP", slug: "recipes/lemp" },
      { label: "MEAN", slug: "recipes/mean" },
      { label: "Rails", slug: "recipes/rails" },
      { label: "Symfony", slug: "recipes/symfony" },
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
