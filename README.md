# Lando 4

Lando runs your local development stack from a `.lando.yml` file. Define your
services, development tools, local URLs, and HTTPS certificates in one place,
then start the environment with `lando start`.

This repository is the experimental v4 rewrite of [Lando](https://lando.dev).
**Public Alpha 1 is not an official Lando release or production-ready.** Commands,
APIs, and configuration may change without migration support. Use the Alpha to
try the new version and report what breaks.

## Install the Alpha

Download the latest `v4.0.0-dev.N` prerelease from
[Releases](https://github.com/AaronFeledy/core4/releases). Binaries are available
for Linux, macOS, and Windows on x64 and ARM64. They are unsigned; installers and
self-update are not available in this Alpha.

Download your platform's binary and `SHA256SUMS`, then follow the
[installation instructions](./docs/alpha-install-and-bug-reports.md) to verify
the checksum and put `lando` on PATH. Check that `lando` resolves to the Alpha
binary, especially if you also have Lando 3 installed:

```sh
lando --version
```

Choose the setup command for your machine:

**Intel Mac:** install and start Docker Desktop first. Setup uses that existing
installation; it does not install Docker for you.

```sh
lando setup --provider=docker
```

**Other supported platforms:** use the default Lando-managed Podman runtime.
You do not need a separate Docker or Podman installation.

```sh
lando setup
```

After setup, check the environment before starting an app:

```sh
lando doctor
```

Resolve any reported issues first. See the
[setup troubleshooting steps](./docs/alpha-install-and-bug-reports.md#run-lando-setup)
if the runtime cannot start, or [choose another provider](./docs/guides/setup/provider-selection.mdx).

## Start a Drupal site

For a new local Drupal 11 site, open a terminal in the directory where you want
Lando to create `drupal-demo/`. Use a location where that directory does not
already exist. Prefer WordPress? Follow the [WordPress quickstart](./docs/guides/recipes/wordpress-workflow.mdx).

```sh
lando init --recipe drupal --name=drupal-demo --yes
cd drupal-demo
lando start
```

The recipe writes `.lando.yml` and starts PHP, Apache, and MariaDB. It does not
install Drupal yet. Download the Drupal project and its local Drush tooling:

```sh
lando drupal-scaffold
lando drush --version
```

Install the site into the new demo database. This initializes the database;
do not run it against an existing site you want to keep.

```sh
lando drush site:install standard --db-url='mysql://lando:lando@database/drupal-demo' --site-name='Drupal Demo' --account-name=admin --account-mail=admin@example.com -y
```

Save the admin password Drush prints. Check the installed site and its URL:

```sh
lando drush status
lando info
```

Open the app HTTPS URL from `lando info`, including any port it shows. You should
see the **Drupal Demo** site. When you finish, stop it without deleting its data:

```sh
lando stop
```

Continue with the [Drupal guide](./docs/guides/recipes/drupal-workflow.mdx) for
existing projects, stack options, database imports, Xdebug, and theme assets.

## Use Lando in your project

- **Coming from Lando 3?** Follow the [migration guide](./docs/guides/tutorial/from-lando-3.mdx).
  Lando 4 does not automatically adopt Lando 3 configuration, containers, or data.
- **Start with a stack:** browse the [bundled recipes](./recipes/) and their walkthroughs.
- **Build your own environment:** explore the [service guides](./docs/guides/services/)
  and [Landofile guides](./docs/guides/landofile/).
- **Run project commands:** add [tooling](./docs/guides/tooling/) for commands inside your services.
- **Find a command or option:** use the [CLI reference](./docs/reference/commands.mdx).

## Extend Lando

Plugin authors can [scaffold a plugin](./docs/guides/plugins/authoring-new-plugin.mdx)
and use the public contracts in `@lando/sdk`. To drive Lando from your own
application instead of the CLI, start with the [embedding guide](./docs/embedding.md).

<a id="building-from-source"></a>
<a id="building-from-source-1"></a>
<a id="compile-a-standalone-binary"></a>

## Contribute

Lando 4 is a Bun and TypeScript monorepo built on Effect. Read the
[contributor source map](./docs/contributing/repository.md) for source builds,
package boundaries, tests, and compiled binaries, then follow the repository
conventions in [AGENTS.md](./AGENTS.md). You do not need the contributor toolchain
to use a prebuilt Alpha binary.

## Get help and report bugs

Search [existing issues](https://github.com/AaronFeledy/core4/issues) before filing
a new one. Include the command, its output, your platform and provider, and
`lando doctor` results. The [bug report checklist](./docs/alpha-install-and-bug-reports.md#bug-report-checklist)
lists useful diagnostics. Remove secrets and credentials before sharing logs.

## License

The [package metadata](./package.json) declares MIT. Copyright Lando Alliance.
