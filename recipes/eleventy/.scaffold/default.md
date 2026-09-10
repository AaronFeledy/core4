# Eleventy

`lando init --recipe eleventy` scaffolds an Eleventy site with a Node builder and an nginx server for the output.

```sh
lando init --recipe eleventy --name=my-eleventy --yes
lando start
lando info
```

Eleventy declares no recipe options, so the only prompt is the app name and `--yes` answers it from `--name`. Pass an `--answer` anyway and init fails instead of quietly ignoring it.

The scaffold writes only `.lando.yml`. It declares two services. `builder` runs on `node:lts` and starts `npx @11ty/eleventy --serve --port 8080`, so Eleventy rebuilds on port 8080 as you edit. `web` runs on `static:nginx`, mounts your app at `/app`, and serves the built output through the proxy on both `http` and `https`. Eleventy never talks to the outside world directly; nginx does.

Two tooling commands ship with the Landofile, both running inside the `builder` service:

```sh
lando eleventy
lando npm install
```

`lando eleventy` wraps `npx @11ty/eleventy`, so `lando eleventy --serve` and `lando eleventy --watch` work the way you'd expect.

`lando start` prints the app URL at `https://<app-name>.lndo.site`. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

## 1. scaffold

```bash
lando init --recipe eleventy --name=my-eleventy-stack --yes
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
lando init --recipe eleventy --name=my-eleventy-stack --yes
```

## 5. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
