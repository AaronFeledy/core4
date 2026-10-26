# Run the Next.js recipe

Create a Next.js development stack with Node and PostgreSQL by default.
Initialization writes only `.lando.yml`; it does not download Next.js or
start its development server. Use the scaffold and server commands below
after starting the services.

Before you begin, install Lando and complete provider setup. For a new app,
run the initialization command from the directory that will contain it. If this
README is already in a generated app, skip the `lando init` and `cd` lines below. Run
the remaining app commands from that directory.

```sh
lando init --recipe nextjs --name=my-nextjs --yes
cd my-nextjs
lando start
lando info
```

## Generate the Next.js app

For a new project, start the services and make sure the app root has no
`package.json`. If you already have a project, skip this scaffold command and
use `lando npm install` instead. To create the new project, run:

```sh
lando nextjs-scaffold
lando next --version
```

It generates the empty TypeScript App Router template (ESLint on, Tailwind off, no `src/`, `@/*` alias, Turbopack) in a temp directory, copies it into the app root without overwriting `.lando.yml` or files you already have, then runs `npm install` in `/app`. Dependencies live in the service's `node_modules` volume mounted at `/app/node_modules`, not in your host tree.

Any existing `package.json` in the app root stops the scaffold before it generates anything, so you can't run it twice. If a generated top-level file collides with one of yours, the command stops before copying and names the first conflicting path.

If `npm install` fails, the generated sources stay. Fix the npm error, then run `lando npm install`.

Already have a project? Skip the scaffold:

```sh
lando npm install
```

## Run the development server

```sh
lando next dev
```

Next listens on all interfaces by default, and the recipe sets `PORT=3000`. No hostname or port flags are needed for the stock recipe. The command stays in the foreground; `lando start` brings up the services but doesn't launch Next.

`lando info` prints the app URL at `https://<app-name>.lndo.site`. Open it while the development server is running.

## Choose stack options

`--yes` uses Node lts, Postgres, and no auth helper. Pass `--answer` to change those.

To choose a different stack, use this initialization command instead of the
default one above. Run it from the parent directory, not inside the app:

```sh
lando init --recipe nextjs --name=my-nextjs --yes \
  --answer=database=none \
  --answer=auth=nextauth
cd my-nextjs
```

| Option | Values | Default |
| --- | --- | --- |
| `node` | `lts`, `22` | `lts` |
| `database` | `postgres`, `mariadb`, `none` | `postgres` |
| `auth` | `none`, `nextauth`, `clerk` | `none` |

Init writes only `.lando.yml` and downloads nothing. It declares a `web` service on `node:<node>` configured for port 3000 with your auth choice exposed as the `NEXTAUTH_PROVIDER` environment variable, plus a `database` service that `web` waits on. Swap `postgres` for `mariadb` and the `database` service changes type. Choose `database=none` to omit the `database` service.

Three tooling commands ship with the Landofile, all running inside the `web` service:

| Command | What it runs |
| --- | --- |
| `lando next` | `npx next`, so `lando next dev` and `lando next build` run in the container |
| `lando npm` | npm in `/app` |
| `lando nextjs-scaffold` | `create-next-app@16.4.0` into the app root, then `npm install` |

`lando destroy -y` removes the app containers and networks and keeps its named volumes. See [Keep data across stop, restart, and destroy](https://aaronfeledy.github.io/core4/guides/tutorial/app-lifecycle/#keep-data-across-stop-restart-and-destroy).

## 1. scaffold

```bash
lando init --recipe nextjs --name=my-nextjs-nextauth --yes
```

## 2. start

```bash
lando start
```

## 3. tooling

```bash
lando app:config --format=json
```

## 4. info

```bash
lando info
```

## 5. init

```bash
lando init --recipe nextjs --name=my-nextjs-nextauth --yes --answer=database=none --answer=auth=nextauth
```

## 6. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
