# Node + Postgres

Create and run a minimal Node.js HTTP server with PostgreSQL. This recipe
includes the server files and has no options beyond the app name.

Before you begin, install Lando and complete provider setup. For a new app,
run the initialization command from the directory that will contain it. If this
README is already in a generated app, skip the `lando init` and `cd` lines below. Run
the remaining app commands from that directory.

```sh
lando init --recipe node-postgres --name=my-node-pg --yes
cd my-node-pg
lando start
lando info
```

The scaffold writes three files: `.lando.yml`, `package.json`, and `server.js`. The Landofile declares a `web` service on `node:lts` that bind-mounts the app directory at `/app`, publishes port `3000:3000`, sets `NODE_ENV=development`, and uses `command: ["node", "/app/server.js"]`. It also declares a `database` service of type `postgres` that `web` waits on.

`server.js` is a plain `http` server that answers `Hello from Lando` on `PORT` (default `3000`). Lando derives `PORT` from `port:`; an unequal or malformed authored `environment.PORT` fails planning. If you change `port:`, also align the container-side port in the explicit `ports:` publication, or remove that publication and use the proxy route. The server closes on SIGTERM or SIGINT and exits within five seconds if connections linger. Replace it with your own app once you have seen it boot.

`lando start` prints the app URL at `https://<app-name>.lndo.site`. `lando info` repeats it.

## Use Yarn or pnpm

The scaffolded `package.json` declares no package manager, so the service uses the npm that ships with the Node image, through `lando npm` and `lando npx`. If you replace the sample with a project that uses Yarn or pnpm, keep that choice in the project. Declare the exact release once in `package.json`, for example
`"packageManager": "pnpm@9.15.0"`. The `web` service installs that release
when Lando builds its image on `lando start`, and swaps `lando npm` and
`lando npx` for `lando pnpm` and `lando pnpx`. A Yarn project gets
`lando yarn`. You don't declare any of it in the Landofile, and you don't run
Corepack.

```sh
lando start
lando pnpm --version
lando pnpm install
```

`lando pnpm --version` prints the pinned version and needs no network. The
install downloads your dependencies, so it does. See
[Use your project's package manager](https://aaronfeledy.github.io/core4/guides/services/node/#use-your-projects-package-manager).

`lando destroy -y` removes the app containers and networks and keeps its named volumes. See [Keep data across stop, restart, and destroy](https://aaronfeledy.github.io/core4/guides/tutorial/app-lifecycle/#keep-data-across-stop-restart-and-destroy).

## 1. scaffold

```bash
lando init --recipe node-postgres --name=my-node-pg --yes
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
