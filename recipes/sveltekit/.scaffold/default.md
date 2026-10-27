# SvelteKit

Create the Lando services for a SvelteKit frontend with Node and an optional
database. The recipe writes `.lando.yml`, not application files. Its adapter
picker records an environment hint; install and configure the adapter yourself.

Before you begin, install Lando and complete provider setup. For a new app,
run the initialization command from the directory that will contain it. If this
README is already in a generated app, skip the `lando init` and `cd` lines below. Run
the remaining app commands from that directory.

```sh
lando init --recipe sveltekit --name=my-sveltekit --yes
cd my-sveltekit
lando start
lando info
```

`--yes` uses Node lts, the `node` adapter, and no database. Pass `--answer` to change those.

To choose a different stack, use this initialization command instead of the
default one above. Run it from the parent directory, not inside the app:

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

`lando destroy -y` removes the app containers and networks and keeps its named volumes. See [Keep data across stop, restart, and destroy](https://aaronfeledy.github.io/core4/guides/tutorial/app-lifecycle/#keep-data-across-stop-restart-and-destroy).

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
