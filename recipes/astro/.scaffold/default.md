# Astro

Create the Lando services for an Astro frontend with an optional content-source
database. The recipe writes `.lando.yml`, not an Astro application; add your
application files and dependencies before running the development server.

Before you begin, install Lando and complete provider setup. For a new app,
run the initialization command from the directory that will contain it. If this
README is already in a generated app, skip the `lando init` and `cd` lines below. Run
the remaining app commands from that directory.

```sh
lando init --recipe astro --name=my-astro --yes
cd my-astro
lando start
lando info
```

`--yes` uses Node lts and no database. Pass `--answer` to change those.

To choose a different stack, use this initialization command instead of the
default one above. Run it from the parent directory, not inside the app:

```sh
lando init --recipe astro --name=my-astro --yes \
  --answer=node=22 \
  --answer=database=postgres
```

| Option | Values | Default |
| --- | --- | --- |
| `node` | `lts`, `22` | `lts` |
| `database` | `none`, `postgres`, `mariadb` | `none` |

The scaffold writes only `.lando.yml`. It declares a `web` service on `node:<node>` with an HTTP endpoint on port 4321 and `ASTRO_TELEMETRY_DISABLED=1` set, to disable Astro telemetry prompts. Pick `postgres` or `mariadb` and the Landofile adds a `database` service of that type that `web` waits on. Keep `none` and there is no `database` service at all.

Lando derives `PORT` from `port:` (default `4321` here), but Astro's Vite development server still needs explicit host and port configuration. The Landofile declares a `dev` task for that. After installing your app and starting it, run `lando dev`.

`lando dev` runs `astro dev --host 0.0.0.0 --port 4321 --allowed-hosts <hostname>`, where the hostname comes from the URL Lando publishes for `web`, so Vite accepts requests through the proxy. It needs a started app. Change the `--port` value in `tooling.dev` when you change `port:`. An unequal or malformed authored `environment.PORT` fails planning. `lando start` keeps the Node service idle; it does not start Astro.

The Landofile also declares `lando astro`, and the `web` service adds `lando npm` and `lando npx`. All of them run inside `web`:

```sh
lando astro --version
lando npm install
```

`lando astro` and `lando dev` run the `astro` binary your project installed, through the project's package manager, so `lando astro build` and `lando astro check` run Astro inside the service. It never downloads Astro, so install your dependencies first. A project that declares Yarn or pnpm in `package.json` gets `lando yarn`, or `lando pnpm` and `lando pnpx`, in place of `lando npm` and `lando npx`.

`lando start` prints the app URL at `https://<app-name>.lndo.site`. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks and keeps its named volumes. See [Keep data across stop, restart, and destroy](https://aaronfeledy.github.io/core4/guides/tutorial/app-lifecycle/#keep-data-across-stop-restart-and-destroy).

## 1. scaffold

```bash
lando init --recipe astro --name=my-astro --yes
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
