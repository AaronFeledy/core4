# Toolbox

`lando init --recipe toolbox` scaffolds one general-purpose CLI service on a pinned Debian image. No web server, no database, no proxy URL.

```sh
lando init --recipe toolbox --name=my-toolbox --yes
lando start
lando info
```

Toolbox declares no recipe options beyond the app name, so `--yes` is enough. The name prompt defaults to `toolbox`, so `lando init --recipe toolbox --yes` with no `--name` gives you an app called `toolbox`. Pass an `--answer` for an option the recipe does not declare and init fails instead of quietly ignoring it.

The scaffold writes only `.lando.yml`. It declares a single `toolbox` service, marked primary, running `sleep infinity` on `debian:12.11-slim`. There is no tooling block and no routes. This recipe is deliberately not web-facing, so `lando info` lists the service and no URL.

The image is pinned to an exact Debian point release on purpose, never a floating tag. You get the same base tomorrow that you got today. The container ships only what `debian:12.11-slim` ships, so install what you need inside it.

The service exists to hold a long-running container you run one-off commands in:

```sh
lando exec toolbox -- cat /etc/os-release
lando exec toolbox -- apt-get update
```

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

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
