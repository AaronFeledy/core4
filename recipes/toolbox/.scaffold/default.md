# Toolbox

Create a general-purpose command-line container on a pinned Debian image.
Toolbox has no web server, database, or proxy URL; use it to run commands
inside a long-running service.

Before you begin, install Lando and complete provider setup. For a new app,
run the initialization command from the directory that will contain it. If this
README is already in a generated app, skip the `lando init` and `cd` lines below. Run
the remaining app commands from that directory.

```sh
lando init --recipe toolbox --name=my-toolbox --yes
cd my-toolbox
lando start
lando info
```

Toolbox declares no recipe options beyond the app name, so `--yes` is enough. The name prompt defaults to `toolbox`, so `lando init --recipe toolbox --yes` with no `--name` gives you an app called `toolbox`. Pass an `--answer` for an option the recipe does not declare and init fails instead of quietly ignoring it.

The scaffold writes only `.lando.yml`. It declares a single `toolbox` service, marked primary, running `sleep infinity` on `debian:12.11-slim`. There is no tooling block and no routes. This recipe is deliberately not web-facing, so `lando info` lists the service and no URL.

The image is pinned to an exact Debian point release on purpose, never a floating tag. The Landofile names that point release rather than following a floating release tag. The container ships only what `debian:12.11-slim` ships, so install what you need inside it.

The service exists to hold a long-running container you run one-off commands in:

```sh
lando exec toolbox -- cat /etc/os-release
lando exec toolbox -- apt-get update
```

`lando destroy -y` removes the app containers and networks and keeps its named volumes. See [Keep data across stop, restart, and destroy](https://aaronfeledy.github.io/core4/guides/tutorial/app-lifecycle/#keep-data-across-stop-restart-and-destroy).

## 1. scaffold

```bash
lando init --recipe toolbox --name=my-toolbox-stack --yes
```

## 2. start

```bash
lando start
```

## 3. info

```bash
lando info
```

## 4. init

```bash
lando init --recipe toolbox --name=my-toolbox-stack --yes
```

## 5. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
