# Eleventy

`lando init --recipe eleventy` scaffolds an Eleventy app with a Node builder and an nginx sidecar.

```sh
lando init --recipe eleventy --name=my-eleventy --yes
cd my-eleventy
lando start
lando info
```

The scaffold writes `.lando.yml` and no templates. Eleventy has no recipe options, so `--yes` accepts the app name from `--name`.

Open the `builder` URL from `lando info`. It points at the Eleventy `--serve` process, which rebuilds and reloads as you work.

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
