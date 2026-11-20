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
install with the package manager that project declares, as described under
[Already have a project?](#already-have-a-project). To create the new project,
run:

```sh
lando nextjs-scaffold
lando next --version
```

It generates the empty TypeScript App Router template (ESLint on, Tailwind off, no `src/`, `@/*` alias, Turbopack) in a temp directory, copies it into the app root without overwriting `.lando.yml` or files you already have, then runs `npm install` in `/app`. Dependencies live in the service's `node_modules` volume mounted at `/app/node_modules`, not in your host tree.

Any existing `package.json` in the app root stops the scaffold before it generates anything, so you can't run it twice. If a generated top-level file collides with one of yours, the command stops before copying and names the first conflicting path.

If `npm install` fails, the generated sources stay. Fix the npm error, then run `lando npm install`.

### Already have a project?

Skip the scaffold and use the package manager your project declares. If
`package.json` declares none, or declares npm, run:

```sh
lando npm install
```

### Projects that use Yarn or pnpm

The scaffold installs with npm. A project you checked out may declare Yarn or
pnpm instead. Declare the exact release once in `package.json`, for example
`"packageManager": "pnpm@9.15.0"`. The `web` service installs that release
when Lando builds its image on `lando start`, and the commands follow it. You
don't declare it again in the Landofile, and you don't run Corepack.

| `package.json` declares | Install | Run Next |
| --- | --- | --- |
| npm, or nothing | `lando npm install` | `lando next dev` |
| pnpm | `lando pnpm install` | `lando next dev` |
| Yarn | `lando yarn install` | `lando next dev` |

For pnpm, start the app and check the release:

```sh
lando start
lando pnpm --version
```

That prints the pinned version and needs no network. Then install
dependencies, which does need the network, and start the development server:

```sh
lando pnpm install
lando next dev
```

`lando next` runs the `next` binary your project installed, through the
project's own manager: `pnpm exec`, `yarn run`, or `npm exec`. It never
downloads Next for you, so run the install first. For Yarn Plug'n'Play, see
[how Lando handles the linker and dependency directory](https://aaronfeledy.github.io/core4/guides/services/node/#use-yarn-plugnplay).

In a pnpm project there is no `lando npm`, and in a Yarn project there is
neither `lando npm` nor `lando pnpm`. See
[Use your project's package manager](https://aaronfeledy.github.io/core4/guides/services/node/#use-your-projects-package-manager).

## Run the development server

After the scaffold or your own install, with npm, pnpm, or Yarn:

```sh
lando next dev
```

Next listens on all interfaces by default and reads `PORT`, which Lando derives from `port:` (default `3000`). No hostname or port flags are needed for the stock recipe. Change `port:` to move both the endpoint and listener; an unequal or malformed authored `environment.PORT` fails planning. The command stays in the foreground; `lando start` brings up the services but doesn't launch Next.

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

These tooling commands run inside the `web` service. The Landofile declares the first two, and the `web` service adds the package-manager commands:

| Command | What it runs |
| --- | --- |
| `lando next` | Your project's own `next` binary, through its package manager, so `lando next dev` and `lando next build` run in the container |
| `lando nextjs-scaffold` | `create-next-app@16.4.0` into the app root, then `npm install` |
| `lando npm`, `lando npx` | npm and npx, when `package.json` declares npm or no package manager |
| `lando pnpm`, `lando pnpx` | pnpm, when `package.json` declares pnpm |
| `lando yarn` | Yarn, when `package.json` declares Yarn |

`lando destroy -y` removes the app containers and networks and keeps its named volumes. See [Keep data across stop, restart, and destroy](https://aaronfeledy.github.io/core4/guides/tutorial/app-lifecycle/#keep-data-across-stop-restart-and-destroy).

## 1. scaffold

```bash
lando init --recipe nextjs --name=my-nextjs --yes
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
