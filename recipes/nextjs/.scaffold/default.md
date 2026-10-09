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

The scaffold writes only `.lando.yml`. It declares a `web` service on `node:<node>` configured for port 3000 with your auth choice exposed as the `NEXTAUTH_PROVIDER` environment variable, plus a `database` service that `web` waits on. Swap `postgres` for `mariadb` and the `database` service changes type. Choose `database=none` and the `database` service is gone, not stubbed.

Two tooling commands ship with the Landofile, both running inside the `web` service:

```sh
lando next --version
lando npm install
```

`lando next` wraps `npx next`, so `lando next dev` and `lando next build` run in the container.

After adding your Next.js app and installing its dependencies, start the development server:

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

## 3. info

```bash
lando info
```

## 4. init

```bash
lando init --recipe nextjs --name=my-nextjs-nextauth --yes --answer=database=none --answer=auth=nextauth
```

## 5. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
