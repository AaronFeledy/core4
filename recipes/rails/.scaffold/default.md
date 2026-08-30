# Rails

`lando init --recipe rails` scaffolds Ruby on Rails, PostgreSQL, Redis, plus `rails` and `bundle` tooling.

```sh
lando init --recipe rails --name=my-rails-app --yes
lando start
lando info
```

`lando start` prints the app URL. `lando info` repeats it.

After start, run app tooling inside the web service:

```sh
lando rails
lando bundle
```

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

## 1. scaffold

```bash
lando init --recipe rails --name=my-rails-app --yes
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
