# Node API

Create the Lando services for a Node API with an Express, Fastify, or Hono
framework choice and an optional PostgreSQL database. The recipe writes only
`.lando.yml`; add the application code and dependencies separately.

Before you begin, install Lando and complete provider setup. For a new app,
run the initialization command from the directory that will contain it. If this
README is already in a generated app, skip the `lando init` and `cd` lines below. Run
the remaining app commands from that directory.

```sh
lando init --recipe node-api --name=my-node-api --yes
cd my-node-api
lando start
lando info
```

The named init creates `my-node-api/`. Change into it before app commands. `--yes` uses Node lts, Express, and Postgres. Pass `--answer` to change those.

To choose a different stack, use this initialization command instead of the
default one above. Run it from the parent directory, not inside the app:

```sh
lando init --recipe node-api --name=my-node-api --yes \
  --answer=node=22 \
  --answer=framework=hono \
  --answer=database=none
```

| Option | Values | Default |
| --- | --- | --- |
| `node` | `lts`, `22` | `lts` |
| `framework` | `express`, `fastify`, `hono` | `express` |
| `database` | `postgres`, `none` | `postgres` |

The scaffold writes only `.lando.yml`. It declares an `api` service on `node:<node>` listening on port 3000 with your framework choice exposed as the `API_FRAMEWORK` environment variable, plus a `database` service when you keep Postgres. Choose `database=none` to omit the `database` service.

Two tooling commands ship with the Landofile, both running inside the `api` service:

```sh
lando npm install
lando node --version
```

When Postgres is present, `api` starts with `DATABASE_URL` set to `postgresql://lando:<password>@database:5432/<app-name>`. Hand it to your client, for example `new pg.Pool({ connectionString: process.env.DATABASE_URL })`. The password comes from the database service's resolved credentials; `lando info` shows the user and database name and redacts the rest. With `database=none` there is no `DATABASE_URL` either.

`lando start` prints the app URL at `https://<app-name>.lndo.site`. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

For day-to-day tooling and `DATABASE_URL` from Node, see [Run the Node API recipe](/guides/recipes/node-api-workflow/).

## 1. scaffold

```bash
lando init --recipe node-api --name=my-node-api --yes
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
