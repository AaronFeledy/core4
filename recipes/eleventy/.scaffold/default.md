# Eleventy

Create the Lando services for an Eleventy site, with a Node builder for
development and nginx for generated static files. The recipe writes
`.lando.yml` and a `package.json` that depends on Eleventy. It does not create
site templates.

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

The scaffold writes `.lando.yml` and `package.json`, and no templates. Eleventy has no recipe options, so `--yes` accepts the app name from `--name`.

`package.json` lists `@11ty/eleventy` as a dev dependency, with a `start` script that runs `eleventy --serve --port 8080` and a `build` script that runs `eleventy`. When `builder` starts, it installs those dependencies with the project's package manager, then runs `start`. You don't install Eleventy yourself. If the install fails, the server never starts; `lando logs --service builder` shows why.

Open the `builder` URL from `lando info`. It points at the Eleventy `--serve` process, which rebuilds and reloads as you work. The app hostname URL (`web`) serves `_site/` through nginx once a build has written it. `lando eleventy` runs the project's installed Eleventy for a one-off build.

For build, browse, and cleanup steps, see [Run the Eleventy recipe](/guides/recipes/eleventy-workflow/).

## 1. scaffold

```bash
lando init --recipe eleventy --name=my-eleventy --yes
```

## 2. inspect-config

## 3. start

```bash
lando start
```

## 4. info

```bash
lando info
```

## Cleanup

```bash
lando destroy -y
```
