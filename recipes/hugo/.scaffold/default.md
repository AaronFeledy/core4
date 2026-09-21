# Hugo

`lando init --recipe hugo` scaffolds a Hugo site with a Node builder and an nginx sidecar.

```sh
lando init --recipe hugo --name=my-hugo --yes
cd my-hugo
lando start
lando info
```

The scaffold writes `.lando.yml` and no site files. Hugo has no recipe options, so `--yes` accepts the app name from `--name`.

Open the `builder` URL from `lando info`. It points at the Hugo `server` process, which rebuilds and reloads as you work.

For install, scaffold, build, browse, and cleanup steps, see [Run the Hugo recipe](/guides/recipes/hugo-workflow/).

## 1. scaffold

```bash
lando init --recipe hugo --name=my-hugo --yes
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
