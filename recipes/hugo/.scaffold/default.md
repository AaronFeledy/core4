# Hugo

`lando init --recipe hugo` scaffolds a Hugo site with a Node builder and an nginx server for the built output.

```sh
lando init --recipe hugo --name=my-hugo --yes
lando start
lando info
```

Hugo declares no recipe options. The only prompt is the app name, so `--yes` plus `--name` gets you all the way through. Pass an `--answer` anyway and init fails instead of quietly ignoring it.

The scaffold writes only `.lando.yml`. It declares two services:

* `builder` on `node:lts`, running `npx hugo server --bind 0.0.0.0 --port 1313` on port 1313. There is no Hugo-specific image; Hugo runs through `npx` inside a Node container.
* `web` on `static:nginx`, with your app mounted at `/app` and one route at `https://<app-name>.lndo.site` over both schemes. It serves whatever Hugo builds.

Two tooling commands ship with the Landofile, both running inside the `builder` service:

```sh
lando hugo version
lando npm install
```

`lando hugo` wraps `npx hugo`, so `lando hugo new site .` and `lando hugo build` work the way the Hugo docs say they do.

`lando start` prints the app URL at `https://<app-name>.lndo.site`. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

## 1. scaffold

```bash
lando init --recipe hugo --name=my-hugo-stack --yes
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
lando init --recipe hugo --name=my-hugo-stack --yes
```

## 5. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
