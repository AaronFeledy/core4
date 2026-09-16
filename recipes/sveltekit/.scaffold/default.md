# SvelteKit

`lando init --recipe sveltekit` scaffolds a SvelteKit frontend on Node with an adapter picker and an optional database.

```sh
lando init --recipe sveltekit --name=my-sveltekit --yes
lando start
lando info
```

`--yes` uses Node lts, the `node` adapter, and no database. Pass `--answer` to change those.

```sh
lando init --recipe sveltekit --name=my-sveltekit --yes \
  --answer=adapter=auto \
  --answer=database=postgres
```

| Option | Values | Default |
| --- | --- | --- |
| `node` | `lts`, `22` | `lts` |
| `adapter` | `node`, `auto` | `node` |
| `database` | `none`, `postgres`, `mariadb` | `none` |

The scaffold writes only `.lando.yml`. It declares a `web` service on `node:<node>` listening on port 5173 with your adapter choice exposed as the `SVELTEKIT_ADAPTER` environment variable. Pick `postgres` or `mariadb` and the Landofile adds a `database` service of that type that `web` waits on. Keep `none` and there is no `database` service at all.

Two tooling commands ship with the Landofile, both running inside the `web` service:

```sh
lando svelte --help
lando npm install
```

`lando svelte` wraps `npx svelte-kit`, so `lando svelte sync` runs the SvelteKit CLI in the container, not on your host.

`lando start` prints the app URL at `https://<app-name>.lndo.site`. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

## 1. scaffold

```bash
lando init --recipe sveltekit --name=my-sveltekit-auto --yes
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
lando init --recipe sveltekit --name=my-sveltekit-auto --yes --answer=adapter=auto --answer=database=postgres
```

## 5. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
