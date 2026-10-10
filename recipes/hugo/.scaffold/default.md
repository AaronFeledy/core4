# Hugo

`lando init --recipe hugo` scaffolds a Hugo site with a Node builder and an nginx sidecar.

```sh
lando init --recipe hugo --name=my-hugo --yes
cd my-hugo
lando start
```

Hugo has no recipe options, so `--yes` accepts the app name from `--name`. Init writes `.lando.yml` plus a small starter site: a Hugo config, an archetype, and enough layouts to render the home page and new content. The `builder` image bakes in a pinned official Hugo extended binary, so there's nothing to install before the first start.

Check the toolchain and find your URLs:

```sh
lando hugo version
lando info
```

Open the `builder` URL from `lando info`. It points at the Hugo `server` process, which rebuilds and reloads as you work. Hugo 0.167.0 writes that output to `public/` on disk, so the app hostname URL (`web`) answers through nginx from the first start and picks up changes as the server rewrites them.

Add a post, then run an explicit build when you want one:

```sh
lando hugo new content posts/hello.md
lando hugo build
```

The starter archetype sets `draft = false`, so the post publishes right away. Set `draft = true` in its front matter to keep a page out of the build while you work on it. `lando hugo build` writes the same `public/` the running server does, so the two don't produce separate outputs.

For the full day-to-day path, see [Run the Hugo recipe](/guides/recipes/hugo-workflow/).

When you are finished:

```sh
lando destroy -y
```
