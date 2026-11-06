# Lando 4

Lando builds containerized local development environments without requiring Docker.
Define your services, development tools, local URLs, and HTTPS certificates in
a `.lando.yml` file, then start the environment with `lando start`.

This repository is Lando 4, the rewrite of [Lando](https://lando.dev) as a Bun and
TypeScript monorepo. Release status and install limits are recorded in
[Alpha install and bug reports](./docs/alpha-install-and-bug-reports.md).

## Install

On Linux, macOS, and WSL, run the installer:

```sh
curl -fsSL https://get.lando.dev/install.sh | sh
```

On Windows, run the [PowerShell installer](./docs/guides/install/windows-installer.mdx).
Each installer verifies the signed release checksum, installs `lando`, prints the
command that puts it on PATH, and offers to run setup. To install a downloaded
binary by hand instead, follow [Install from a GitHub release](./docs/guides/install/github-releases.mdx)
and [Put lando on PATH and run setup](./docs/guides/install/path-and-setup.mdx).

Check that `lando` resolves to the new binary, especially if you also have
Lando 3 installed:

```sh
lando version
```

Lando manages its own Podman runtime, so you do not need to install a container
runtime separately.

**Intel Mac limitation:** the managed provider is not supported on Intel Macs.
Install and start Docker Desktop first, then choose Docker when setup asks. See
the [platform guidance](./docs/alpha-install-and-bug-reports.md#choose-setup-for-your-platform).

Run setup and follow the prompts:

```sh
lando setup
```

After setup, check the environment before starting an app:

```sh
lando doctor
```

Resolve any reported issues first. See the
[setup troubleshooting steps](./docs/alpha-install-and-bug-reports.md#run-lando-setup)
if the managed runtime cannot start. Use [another provider](./docs/guides/setup/provider-selection.mdx)
only as a fallback when the managed provider does not work on your machine.

## Start a Drupal project

For a new local project, create an empty directory and initialize it
there. Prefer WordPress? Follow the [WordPress quickstart](./docs/guides/recipes/wordpress-workflow.mdx).

```sh
mkdir drupal-demo
cd drupal-demo
lando init
```

Choose **Drupal**, use `drupal-demo` as the app name, and keep the remaining
defaults for this example. Lando writes `.lando.yml` into the current directory.
Start the services, download Drupal and its project-local Drush, then find the
app URL:

```sh
lando start
lando drupal-scaffold
lando info
```

Check that `appserver` and `database` appear in `lando info`. You now have the
local services and Drupal project files, including project-local Drush. The
Drupal site is not installed yet. Continue with the
[Drupal guide](./docs/guides/recipes/drupal-workflow.mdx) to install the site or
bring in an existing project's data.

When you finish, stop the environment without deleting its data:

```sh
lando stop
```

## Use Lando in your project

- **Coming from Lando 3?** Follow the [migration guide](./docs/guides/tutorial/from-lando-3.mdx).
  Lando 4 does not automatically adopt Lando 3 configuration, containers, or data.
- **Start with a stack:** browse the [bundled recipes](./recipes/) and their walkthroughs.
- **Build your own environment:** explore the [service guides](./docs/guides/services/)
  and [Landofile guides](./docs/guides/landofile/).
- **Run project commands:** add [tooling](./docs/guides/tooling/) for commands inside your services.
- **Find a command or option:** use the [CLI reference](./docs/reference/commands.mdx).
- **Stay current:** `lando update` replaces an installer-managed binary from the
  signed channel manifest. See [Update channels and manifests](./docs/guides/update/channels-and-manifests.mdx).

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
to use a prebuilt binary.

## Get help and report bugs

Search [existing issues](https://github.com/AaronFeledy/core4/issues) before filing
a new one. Include the command, its output, your platform and provider, and
`lando doctor` results. The [bug report checklist](./docs/alpha-install-and-bug-reports.md#bug-report-checklist)
lists useful diagnostics. Remove secrets and credentials before sharing logs.

## License

The [package metadata](./package.json) declares MIT. Copyright Lando Alliance.
