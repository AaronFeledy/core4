---
title: Lando
description: Lando runs your project's whole local development stack from one config file, on a container runtime you control.
template: splash
head:
  - tag: title
    content: Lando — local development environments from one config file
hero:
  tagline: Describe your stack in one file. Lando builds and runs it in containers, so local setup stops being a project of its own.
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

Lando is a local development environment tool. You describe what your app needs — an appserver, a database, a cache, the tooling you run every day — in a single `.lando.yml` Landofile. Then you run `lando start` and get the environment everyone else on the project gets.

Those services run in containers on a runtime you control: Lando-managed Podman by default, or a system Docker or Podman install you already have. You configure your app. Lando deals with the containers.

## Where to go next

| Section | What's there |
| --- | --- |
| [Install the Alpha](./alpha-install-and-bug-reports/) | Install paths, checksum verification, and what to attach to a bug report. |
| [Guides](./guides/tutorial/app-lifecycle/) | Walkthroughs for services, tooling, plugins, and the CLI. Most run as executable tests, so they stay in step with the code. |
| [Recipes](./recipes/wordpress/) | Ready-made stacks for Drupal, Drupal CMS, LAMP, LEMP, and WordPress. |
| [Reference](./reference/commands/) | Generated command and schema reference, down to individual flags. |
| [Embedding](./embedding/) | Drive the `@lando/core` library API from your own application. |

## Before you start

Lando 4 is a pre-release rewrite, and this Alpha is not production-ready. Commands, the Landofile format, and the plugin API can still change between builds, and some command surfaces are not implemented yet.

When something breaks — and it will — the [Alpha install and bug reports](./alpha-install-and-bug-reports/) page lists the diagnostics worth attaching.
