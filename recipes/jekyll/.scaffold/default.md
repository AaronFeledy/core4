# Jekyll

Create the Lando services for Jekyll, with a Ruby builder and nginx for
generated static files. The recipe writes `.lando.yml`, not a Jekyll site.
Before starting it, follow the setup steps linked below to install gems and
create the site.

Before you begin, install Lando and complete provider setup. For a new app,
run the initialization command from the directory that will contain it. If this
README is already in a generated app, skip the `lando init` and `cd` lines below. Run
the remaining app commands from that directory.

```sh
lando init --recipe jekyll --name=my-jekyll --yes
cd my-jekyll
```

Jekyll declares no recipe options, so the only prompt is the app name and `--yes` answers it. Pass an undeclared `--answer` and init fails instead of quietly ignoring it.

The scaffold writes only `.lando.yml`. Its `builder` service carries a build step that installs `build-essential`, `libssl-dev`, and `zlib1g-dev` on the first start, so native gems compile without extra apt setup. Park `builder` on `sleep infinity` before the first start, install gems and scaffold the site, then restore the serve command. Open the **builder** URL from `lando info` after that restore. The app hostname URL (`web`) serves `_site/` through nginx once a build has written it.

For park, install, scaffold, build, browse, and cleanup steps, see [Run the Jekyll recipe](/guides/recipes/jekyll-workflow/).

When you are finished, remove the app containers and networks. This keeps
named volumes unless you also pass `--volumes` or `--purge`. See [Keep data across stop, restart, and destroy](https://aaronfeledy.github.io/core4/guides/tutorial/app-lifecycle/#keep-data-across-stop-restart-and-destroy):

```sh
lando destroy -y
```
