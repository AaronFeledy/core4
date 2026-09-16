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

For day-to-day tooling and DB/Redis hosts, see [Run the Rails recipe](/guides/recipes/rails-workflow/).

## Choose Redis persistence

Redis keeps data across restarts by default. For disposable caches, set `persist: false` on your Redis service and rebuild. That disables its durable data store, AOF, and RDB snapshots. Don't use it for queues or data you need to keep.

Set `password:` on the same service to require authentication. Configure your Rails Redis client with the matching password; `lando redis-cli` authenticates automatically. Verify the change with `lando redis-cli ping` after `lando rebuild`. See [Add Redis](../../docs/guides/services/redis.mdx) for secret references and restart checks.

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
