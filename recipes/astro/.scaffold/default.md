# Astro

`lando init --recipe astro` scaffolds an Astro frontend on Node with an optional content-source database.

```sh
lando init --recipe astro --name=my-astro --yes
lando start
lando info
```

`--yes` uses Node lts and no database. Pass `--answer` to change those.

```sh
lando init --recipe astro --name=my-astro --yes \
  --answer=node=22 \
  --answer=database=postgres
```

| Option | Values | Default |
| --- | --- | --- |
| `node` | `lts`, `22` | `lts` |
| `database` | `none`, `postgres`, `mariadb` | `none` |

The scaffold writes only `.lando.yml`. It declares a `web` service on `node:<node>` listening on port 4321 with `ASTRO_TELEMETRY_DISABLED=1` set, so Astro stops asking. Pick `postgres` or `mariadb` and the Landofile adds a `database` service of that type that `web` waits on. Keep `none` and there is no `database` service at all.

Two tooling commands ship with the Landofile, both running inside the `web` service:

```sh
lando astro --version
lando npm install
```

`lando astro` wraps `npx astro`, so `lando astro dev` and `lando astro build` work as you'd expect.

`lando start` prints the app URL at `https://<app-name>.lndo.site`. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

## 1. scaffold

```bash
lando init --recipe astro --name=my-astro-postgres --yes
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
lando init --recipe astro --name=my-astro-postgres --yes --answer=node=22 --answer=database=postgres
```

## 5. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
