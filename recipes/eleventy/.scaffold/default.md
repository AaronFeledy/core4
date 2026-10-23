# Eleventy

Create the Lando services for an Eleventy site, with a Node builder for
development and nginx for generated static files. The recipe writes
`.lando.yml` but does not create site templates.

Before you begin, install Lando and complete provider setup. For a new app,
run the initialization command from the directory that will contain it. If this
README is already in a generated app, skip the `lando init` and `cd` lines below. Run
the remaining app commands from that directory.

```sh
lando init --recipe eleventy --name=my-eleventy --yes
cd my-eleventy
lando start
lando info
```

The scaffold writes `.lando.yml` and no templates. Eleventy has no recipe options, so `--yes` accepts the app name from `--name`.

Open the `builder` URL from `lando info`. It points at the Eleventy `--serve` process, which rebuilds and reloads as you work. The app hostname URL (`web`) serves `_site/` through nginx once a build has written it.

For install, build, browse, and cleanup steps, see [Run the Eleventy recipe](/guides/recipes/eleventy-workflow/).

## 1. scaffold

```bash
lando init --recipe eleventy --name=my-eleventy --yes
```

## 2. start

```bash
lando start
```

## 3. info

```bash
lando info
```

## Cleanup

```bash
lando destroy -y
```
