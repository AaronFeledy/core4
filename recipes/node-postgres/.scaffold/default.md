# Node + Postgres

`lando init --recipe node-postgres` scaffolds a minimal Node.js server next to a Postgres database. There are no options beyond the app name.

```sh
lando init --recipe node-postgres --name=my-node-pg --yes
lando start
lando info
```

The scaffold writes three files: `.lando.yml`, `package.json`, and `server.js`. The Landofile declares a `web` service on `node:lts` that bind-mounts the app directory at `/app`, publishes port `3000:3000`, sets `NODE_ENV=development`, and runs `node /app/server.js`. It also declares a `database` service of type `postgres` that `web` waits on.

`server.js` is a plain `http` server that answers `Hello from Lando` on port 3000. Replace it with your own app once you have seen it boot.

`lando start` prints the app URL at `https://<app-name>.lndo.site`. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

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
