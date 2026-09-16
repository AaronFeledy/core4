# Node API

`lando init --recipe node-api` scaffolds a Node API service with an Express, Fastify, or Hono framework picker and an optional Postgres database.

```sh
lando init --recipe node-api --name=my-node-api --yes
lando start
lando info
```

`--yes` uses Node lts, Express, and Postgres. Pass `--answer` to change those.

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

The scaffold writes only `.lando.yml`. It declares an `api` service on `node:<node>` listening on port 3000 with your framework choice exposed as the `API_FRAMEWORK` environment variable, plus a `database` service when you keep Postgres. Choose `database=none` and the `database` service is gone, not stubbed.

Two tooling commands ship with the Landofile, both running inside the `api` service:

```sh
lando npm install
lando node --version
```

`lando start` prints the app URL at `https://<app-name>.lndo.site`. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

## 1. scaffold

```bash
lando init --recipe node-api --name=my-node-api-hono --yes
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
lando init --recipe node-api --name=my-node-api-hono --yes --answer=node=22 --answer=framework=hono --answer=database=none
```

## 5. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
