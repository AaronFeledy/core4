---
title: Lando
description: Lando runs your project's whole local development stack from one config file, on a container runtime you control.
template: splash
head:
  - tag: title
    content: Lando local development environments from one config file
hero:
  image:
    file: ./src/assets/lando-logo.svg
    alt: Lando logo
  tagline: Define your local development stack in one file. Lando builds and runs its services in containers.
  actions:
    - text: Install the Alpha
      link: ./alpha-install-and-bug-reports/
      icon: right-arrow
      variant: primary
    - text: Start with the tutorial
      link: ./guides/tutorial/app-lifecycle/
      icon: open-book
      variant: minimal
---

## What Lando is

Lando runs your app services and everyday tooling from a `.lando.yml` config file, called a Landofile. Keep the appserver, database, cache, and their configuration together so your team can share the same stack definition.

Lando 4 is a pre-release rewrite, and this Alpha is not production-ready. Start with [the Alpha install instructions](./alpha-install-and-bug-reports/) before running the tutorial.

Those services run in containers on a runtime you control: Lando-managed Podman by default, or a system Docker or Podman install you already have. You configure your app. Lando deals with the containers.

## Where to go next

| Section | What's there |
| --- | --- |
| [Install the Alpha](./alpha-install-and-bug-reports/) | Install paths, checksum verification, and what to attach to a bug report. |
| [Tutorial](./guides/tutorial/app-lifecycle/) | Start here: learn the everyday commands for starting, inspecting, and tearing down apps. |
| [Recipes](./recipes/wordpress/) | Start with WordPress, or choose another ready-made app stack. |
| [Reference](./reference/commands/) | Generated command and schema reference, down to individual flags. |
| [Embedding](./embedding/) | Drive the `@lando/core` library API from your own application. |

## Before you start

Commands, the Landofile format, and the plugin API can still change between Alpha builds. Check the install page for current support limits.

If you hit a problem, follow [Alpha install and bug reports](./alpha-install-and-bug-reports/) to collect the diagnostics maintainers need.
