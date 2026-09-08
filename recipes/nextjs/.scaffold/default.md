# Next.js

`lando init --recipe nextjs` scaffolds Node, optional Postgres or MariaDB, next and npm tooling, and an Auth env hint.

```sh
lando init --recipe nextjs --name=my-nextjs-app --yes
lando start
lando info
```

`--yes` uses Node lts, Postgres, and `NEXTAUTH_PROVIDER: none`. Pass `--answer` to change those.

```sh
lando init --recipe nextjs --name=my-nextjs-app --yes \
  --answer=node=22 \
  --answer=database=none \
  --answer=auth=nextauth
```

`lando start` prints the app URL. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

## 1. scaffold

```bash
lando init --recipe nextjs --name=my-nextjs-alt --yes
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
lando init --recipe nextjs --name=my-nextjs-alt --yes --answer=node=22 --answer=database=none --answer=auth=nextauth
```

## 5. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
