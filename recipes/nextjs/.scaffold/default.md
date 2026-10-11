# Run the Next.js recipe

`lando init --recipe nextjs` writes a Next.js Landofile with Node, a Postgres database by default, and an optional auth helper picker.

```sh
lando init --recipe nextjs --name=my-nextjs --yes
cd my-nextjs
lando start
lando info
```

`--yes` uses Node lts, Postgres, and no auth helper. Pass `--answer` to change those.

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

Init writes only `.lando.yml` and downloads nothing. It declares a `web` service on `node:<node>` configured for port 3000 with your auth choice exposed as the `NEXTAUTH_PROVIDER` environment variable, plus a `database` service that `web` waits on. Swap `postgres` for `mariadb` and the `database` service changes type. Choose `database=none` and the `database` service is gone, not stubbed.

Three tooling commands ship with the Landofile, all running inside the `web` service:

| Command | What it runs |
| --- | --- |
| `lando next` | `npx next`, so `lando next dev` and `lando next build` run in the container |
| `lando npm` | npm in `/app` |
| `lando nextjs-scaffold` | `create-next-app@16.4.0` into the app root, then `npm install` |

## Generate the Next.js app

With the services up, scaffold a project into the app root:

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

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

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
