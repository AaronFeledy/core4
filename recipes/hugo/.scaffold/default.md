# Hugo

`lando init --recipe hugo` scaffolds a Hugo site with a Node builder and an nginx sidecar.

```sh
lando init --recipe hugo --name=my-hugo --yes
cd my-hugo
```

The scaffold writes `.lando.yml` and no site files. Hugo has no recipe options, so `--yes` accepts the app name from `--name`. Park `builder` before the first start so the recipe's `npx hugo server` command does not download an unintended package while the app is empty:

```yaml
services:
  builder:
    command: sleep infinity
    port: 1313
    type: node:lts
```

Start the parked services and install the intended Hugo dependency:

```sh
lando start
lando npm init -y
lando npm install hugo-extended --save-dev
lando npm install-scripts approve hugo-extended
lando npm rebuild hugo-extended
lando hugo version
```

Create the site while `builder` is still parked:

```sh
lando hugo new site . --force
```

Restore the recipe server command in `.lando.yml`:

```yaml
services:
  builder:
    command: "npx hugo server --bind 0.0.0.0 --port 1313"
    port: 1313
    type: node:lts
```

Restart and inspect the running app:

```sh
lando restart
lando info
```

Open the `builder` URL from `lando info`. It points at the Hugo `server` process, which rebuilds and reloads as you work.

For install, scaffold, build, browse, and cleanup steps, see [Run the Hugo recipe](/guides/recipes/hugo-workflow/).

When you are finished:

```sh
lando destroy -y
```
