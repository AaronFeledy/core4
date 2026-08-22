# MEAN

`lando init --recipe mean` scaffolds Node, MongoDB, optional Redis, npm tooling, and an Express-style default scaffold. There is no framework picker.

```sh
lando init --recipe mean --name=my-mean-app --yes
lando start
lando info
```

`--yes` uses Node lts, MongoDB, and no Redis. Pass `--answer` to change those.

```sh
lando init --recipe mean --name=my-mean-app --yes \
  --answer=node=22 \
  --answer=redis=true
```

`lando start` prints the app URL. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

## 1. scaffold

```bash
lando init --recipe mean --name=my-mean-redis --yes
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
lando init --recipe mean --name=my-mean-redis --yes --answer=node=22 --answer=redis=true
```

## 5. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
