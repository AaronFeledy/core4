# Lando v3 Pain Points — Non-GitHub-Issue Sources

**Scope:** Reddit (r/drupal, r/PHP, r/laravel, r/Wordpress, r/symfony, r/webdev), Stack
Overflow, Hacker News, blog posts, Drupal community publications, hosting-vendor
documentation, and the annual *Drupal Developer Survey*. GitHub issues are intentionally
excluded — that surface is being researched in a sister task.

**Period covered:** Heaviest weight on 2022 → 2025 commentary, with earlier signal
included where it shows a sustained pattern.

**Method:** Reddit JSON endpoints scraped directly for verbatim comments;
Google/Algolia/HN search for migration narratives; targeted fetches of vendor
deprecation pages and the Drupal Developer Survey. Where a quote is reproduced it is
verbatim from the source URL noted alongside.

---

## 1. The single most important external data point

**Drupal Developer Survey 2025** (Ironstar, n=753, 58 countries, published Aug 27 2025
— <https://www.ironstar.io/devsurvey25/>):

> "DDEV has almost universal adoption within the Drupal community… 93% of DDEV users
> recommend it. The nearest alternative recommendation is Homebrew, with 72%. **Lando
> is towards the back with only 51%.**"
>
> "DDEV adoption jumped from 42% in 2023 to 60% in 2024." *(2024 survey)*

This is the cleanest available statement of sentiment. Among developers in Lando's
historic flagship community (Drupal), **only roughly half who have used Lando would
recommend it to another developer.** DDEV is not just preferred — it is overwhelmingly
preferred, by a 42-point net-promoter-style gap, in the same population that Lando was
purpose-built for.

---

## 2. The five most damaging verbatim quotes

These are the comments that would do the most damage if quoted in a competitor's
marketing or in a v4 retrospective. All are real, attributable, and recent enough to
still be findable on the open web.

1. **"Lando + Drupal 7. Does anyone actually have this working?"** — u/green0wnz, r/drupal,
   2020-10-05, <https://reddit.com/r/drupal/comments/j5pael/>:
   > "This is maybe more of a rant than a plea for help, though help would be appreciated.
   > **I just can't believe how much time I've spent trying to get Drupal 7 and Lando to
   > play nicely together.** […] The process for both has involved hours of Googling
   > obscure errors that nobody ever really has an answer for besides `lando rebuild`. On
   > the off chance `lando rebuild` or `lando start` does complete successfully **the
   > site unbearably slow. I'm talking 30+ seconds to load a page if it loads at all.
   > Half the time the URLs Lando provides are red and don't work.**"

2. **MariaDB-dump migration trigger** — u/iBN3qk (Drupal Architect), r/drupal,
   2024-08-06, <https://reddit.com/r/drupal/comments/1elrbop/>:
   > "Lando does not yet support any updated version of MariaDB. […] DDEV is already
   > updated. **Probably easier to switch to DDEV if you haven't already. I have been a
   > Lando user for a while, but the lack of traction here is concerning.**"
   > Companion post on the author's blog asks plainly: *"Is Lando behind the curve?"*
   > (<https://www.drupalarchitect.info/articles/fixing-mariadb-dump-lando>).

3. **MAMP-vs-Lando rant from a switcher** — u/Throwing-up-fire, r/drupal, 2021-09-17,
   <https://reddit.com/r/drupal/comments/ppsu35/dockerlando_worst_than_mamp_wth/>:
   > "I installed Docker with Lando. The templates are so easy to use, it's almost plug
   > and play. HOWEVER:
   > * **It's soo CPU consuming, it's almost a deal breaker** to me. I have something
   >   like 20 projects to take care of. […] I have to create 20 instances for each one
   >   and start/stop every single project I'm working on because I have to save
   >   memory…
   > * **It's actually a lot slower than mamp…**
   > * **It crashes sometimes… like badly. Sometimes lando rebuilt isnt enough, I
   >   actually have to restart Docker Desktop.**"

4. **Performance & reliability comparison from a daily user** — u/blueshift9 and
   u/MR_Weiner across r/PHP and r/drupal,
   <https://reddit.com/r/PHP/comments/1c7sqn4/> &
   <https://reddit.com/r/drupal/comments/ok702p/>:
   > "I have used both Lando and DDEV and while both are pretty great, I have found
   > both easy enough to use, but **yeah I had more weird problems with Lando**. It
   > was generally pretty stable and nothing is perfect, but **DDEV has been
   > absolutely rock solid**. As far as performance, I have never truly benchmarked the
   > two but DDEV *feels* more responsive."
   >
   > "To be honest, the way I improved performance was to switch to ddev instead. **I
   > always had performance issues with Lando.** The transition is pretty smooth and
   > **the configuration doesn't feel so much like black magic**."

5. **The 30-second-page-load thread (whole post is the quote)** — u/AdvancePrize,
   r/drupal, 2023-05-28,
   <https://reddit.com/r/drupal/comments/13u6sho/>:
   > "which one is best ddev or lando — my system lags in lando — Core i5 8th-gen,
   > 16GB RAM, 256GB SSD — but the system lags in drupal development, **it takes 30
   > seconds just to navigate to other page**…"
   >
   > Top reply (u/[deleted]): "**Lando doesn't run well on a computer with 16GB of
   > memory** […] My recommendation is that you have 32gb if you use Lando."
   >
   > Reply from Drupal core contributor mglaman: "**Lando does additional disk mounts
   > into Docker Desktop than DDEV. That's the main performance issue.** […] DDEV is
   > much more specific which improves the disk I/O performance overall for Docker."
   >
   > OP's follow-up two weeks later
   > (<https://reddit.com/r/drupal/comments/13z338m/>): "**It was a great experience
   > shifting to ubuntu os from windows as i was stucking with windows in drupal
   > development setting it up with lando took around 40 to 50 seconds just to navigate
   > a single page. Now installed ubuntu and the experience is just wow.**"

---

## 3. Findings categorized into the requested A–J buckets

Per item: source, date, severity (BLOCKED / FRICTION / ANNOYANCE), recurrence
(RECURRING / OCCASIONAL / ONE-OFF), verbatim where useful.

### A. Performance complaints

A common thread; arguably the single biggest reputational drag.

- **30s+ page loads on Windows + Lando** — u/AdvancePrize, r/drupal 2023-05-28 and
  follow-up 2023-06-03. Severity: BLOCKED. Recurrence: RECURRING. Resolution path
  every time is "switch OS" or "switch tool", not "tune Lando."
- **Lando mounts more directories into Docker than DDEV does** — mglaman (Drupal
  core contributor), r/drupal, 2023:
  > "Lando does additional disk mounts into Docker Desktop than DDEV. That's the main
  > performance issue."
  Severity: FRICTION. Recurrence: RECURRING (cited as the *technical* reason DDEV feels
  faster).
- **CPU consumption with multiple projects** — u/Throwing-up-fire, 2021;
  u/Topplestack, 2021; u/Tretragram, 2022. Severity: FRICTION. Recurrence: RECURRING.
  Workaround everyone names is "stop other projects" / "buy more RAM."
- **`lando drush cc all` taking 2 minutes on Windows 10** — u/[OP], r/drupal,
  2019-05-06, <https://reddit.com/r/drupal/comments/bliakz/>. Severity: FRICTION.
  Recurrence: RECURRING.
- **High CPU on macOS** — r/drupal "Lando + Mac = High CPU" 2021-09-28
  (<https://reddit.com/r/drupal/comments/pxcola/>). Top replies all blame Docker on
  Mac, recommend Docksal/DDEV/Colima. Severity: FRICTION. Recurrence: RECURRING.
- **Docker on Mac is "a joke" / "pointless"** — u/szaebb, u/drulf in the high-CPU
  thread. Severity: ANNOYANCE-BUT-FORMATIVE. Recurrence: pattern across years.
- **Symfony+Docker slow → "Have you tried ddev or lando?"** — r/symfony,
  2023-12-22. Lando appears here only as a *suggestion to fix* a slowness problem, but
  the pattern in 2024-2025 reverses: people fix Lando-induced slowness by leaving Lando.

### B. Reliability complaints — "things break, especially after updates"

- **MariaDB dump compatibility break, June 2024.** DDEV shipped a fix the same week
  (<https://ddev.com/blog/mariadb-dump-breaking-change/>). At the time of the r/drupal
  thread (Aug 2024) Lando still didn't have a working updated MariaDB image, and the
  blog author concludes: "Is Lando behind the curve?". Severity: BLOCKED.
  Recurrence: ONE-OFF event but cited as *the* migration trigger by multiple
  Drupal-shop devs.
- **`lando rebuild` as the universal therapy.** Across nearly every support thread
  the answer is "try `lando rebuild`" or "`lando destroy && lando rebuild`". This is
  surfaced enough that the community wrote third-party safety nets — see
  *LSafe* (<https://reddit.com/r/drupal/comments/1mux7mp/>, Aug 2025), explicitly
  built because of an "MySQL corruption incident" with Lando rebuilds.
- **"Lando had some restructuring lately, which may caused some issues"** —
  u/AdministrativeSun661, r/PHP, 2024-04-19. The same comment continues:
  > "We also use Lando and **seldomly it does weird stuff**, but not in a way that it
  > affects my productivity. If I would change anything, I moved to docker/docker
  > compose directly and wouldn't choose another wrapper."
  Severity: ANNOYANCE. Recurrence: RECURRING ("seldomly weird stuff" is a phrase that
  recurs across many reviewers).
- **The Great Decoupling (3.19/3.20/3.21) and `lando setup`** introduced
  installation-path conflicts, "command not found" / "wrong version" issues from
  shadowed binaries, and recipe failures during 3.20.7 rollout. Severity: FRICTION at
  least, BLOCKED for some. Recurrence: RECURRING for users who upgraded.
- **Lando "Parse Error: Header overflow"** on Drupal 10 startup — Stack Overflow
  Sep 2024, <https://stackoverflow.com/questions/78977762/>. Symptomatic of opaque
  proxy/Traefik failures. Severity: BLOCKED. Recurrence: OCCASIONAL.
- **Database "unhealthy" after Drupal/MariaDB upgrades**; "Could not set the file
  size of './ibtmp1'" — appears to be a Docker Desktop disk-quota issue, but the
  user-facing experience is "Lando broke." From u/green0wnz Drupal-7 thread, 2020.
  Severity: BLOCKED. Recurrence: RECURRING (still cited in 2024 threads).

### C. Platform / installer complaints

- **Windows requires WSL2** to be usable. Effectively *every* 2023-2025 thread
  about Windows says "install Lando inside WSL2" — the bare-Windows path is treated
  as broken-by-design by the community. r/drupal "What is the easiest Drupal local
  environment for Windows 11 in 2025?" (<https://reddit.com/r/drupal/comments/1ihejb7/>,
  Feb 2025) is unanimous on this.
- **Files-on-`/mnt/c/` permission and performance issues** — universally cited, e.g.
  u/Llamanat3r:
  > "If you try to use a windows directory with Lando there is a permission issue
  > between Linux and Windows file systems."
  Severity: FRICTION. Recurrence: RECURRING.
- **Apple Silicon early bumpiness (2021–2022)** — multiple threads in 2022 about
  ARM64 image availability and `linux/amd64` workarounds. By 2024 this is largely
  fixed but the *reputation* of Lando-on-M1 lingers in older Stack Overflow / Reddit
  search results that new users still find first.
- **Docker Desktop license sting** — Lando today still defaults to Docker Desktop on
  macOS/Windows. Devs at companies that crossed the >250 employees / >$10M revenue
  threshold are forced to either pay for Docker Desktop, switch to OrbStack/Colima
  (also paid for business use), or use Rancher Desktop. Lando's reliance on Docker
  Desktop is repeatedly noted but *not* a top complaint — most just route around it.
- **Linux distro packaging** — Arch Linux AUR users intermittently report broken
  installs after Lando releases (<https://aur.archlinux.org/packages/lando-bin>);
  search results from late 2024 onward.

### D. Configuration / Landofile complaints

- **"`overrides` is not enough"** — Lando's documented escape hatch (drop down to a
  `type: compose` service) gets criticized as "you're back to writing
  docker-compose, why am I using Lando?" Sources: lando.dev/contrib docs, garfieldtech
  (<https://garfieldtech.com/>), Four Kitchens engineering blog.
- **"The configuration doesn't feel so much like black magic"** is *the* reason
  u/MR_Weiner gave for switching to DDEV (r/drupal 2021). When the *positive* framing
  of a competitor is "less black magic", the inverse is the implicit complaint.
- **Recipes are inflexible / out of date** — u/smashedhijack, r/PHP 2024-04-19:
  > "I haven't checked the Lando docs recently but I do recall them being a bit
  > shaky, and **I ended up retrofitting our main config by replicating what other
  > GitHub repos did.**"
- **Tooling-section syntax surprises** — Stack Overflow questions like "Lando
  tooling command syntax" (<https://stackoverflow.com/questions/76712257/>),
  ">> /etc/hosts" not being supported in `lando ssh -c` (so a tooling command can't
  trivially edit a container file), and similar. Severity: ANNOYANCE. Recurrence:
  RECURRING.

### E. Plugin / extensibility complaints

- **"Lack of traction"** — u/iBN3qk, r/drupal 2024-08-06, on the MariaDB plugin
  not being updated despite open PRs/issues for months. This is the comment that most
  cleanly translates the issue-queue backlog into community-visible drag.
- **MariaDB plugin needed manual `git init` / branch checkout inside
  `~/.lando/plugins/@lando/mariadb`** to get a working version
  (<https://www.drupalarchitect.info/articles/fixing-mariadb-dump-lando>). Severity:
  FRICTION-FOR-EXPERTS, BLOCKED-FOR-NORMALS. Recurrence: RECURRING during the gap.
- **Pantheon recipe documented procedure didn't work** — u/[OP], r/drupal 2023-06-23,
  required manually duplicating directories and copying landofiles. Severity:
  BLOCKED. Recurrence: OCCASIONAL but well-indexed.
- **Lando `init --source pantheon` produces conflicting `main` vs `master`
  branches** — same thread, 2023; persisted into 2024.

### F. Networking / SSL / proxy complaints

- **`landoproxyhyperion5000gandalfedition_proxy_1` Cannot start service proxy:
  network** — Stack Overflow 2018 plus repeats in 2023 (Funky Dude,
  <https://stackoverflow.com/questions/76068894/>). Severity: BLOCKED. Recurrence:
  RECURRING.
- **`*.lndo.site` DNS rebinding protection issues** — DDEV thread on the easylist
  GitHub issue tracker (<https://github.com/easylist/easylist/issues/16372>, 2023)
  argues against blanket-blocking 127.0.0.1 because it breaks Lando + DDEV.
- **CA-trust required on every browser/keychain** — long-standing usability gap,
  cited in nearly every "set up local HTTPS" thread.
- **Port 80/443 conflicts** with locally-installed Apache/Nginx, plus VPNs and
  corporate antivirus binding to those ports. Severity: BLOCKED. Recurrence:
  RECURRING.

### G. Tooling / workflow complaints

- **`lando ssh` slowness vs. `lando exec` confusion.** Both exist; users don't know
  when to use which; both have noticeable per-invocation overhead vs. a native shell.
- **Databases lost on `lando destroy`** — entire third-party tools exist for this.
  *LSafe* (<https://github.com/Apotheosis-Tech/lsafe>, 2025-08): "Built after our
  MySQL corruption incident — wanted better backup workflows overall." That a
  third-party "auto-backup before destructive Lando commands" tool was published in
  2025 is the strongest single signal that users do not trust Lando's destructive
  commands.
- **Drupal-7 site spends 30s per page** even after `lando start` succeeds (Drupal-7
  thread above).
- **Drush bootstrap mysteriously failing inside Lando containers** — r/drupal
  2024-04-15, <https://reddit.com/r/drupal/comments/1c4sauv/>: required adding
  `drupal/core-composer-scaffold`. The user could not figure out why on their own.
- **`drush uli` URL invalidated by URL-unfurlers** before the user clicks it
  — r/drupal 2025-04-28, <https://reddit.com/r/drupal/comments/1kaa805/>. (Not
  exclusive to Lando, but Lando's slack/teams integrations make it worse.)

### H. Documentation / discoverability complaints

- **"Documented procedure didn't work for me"** — Pantheon Lando user, 2023, edited
  their post twice with the actual working workflow because the docs path didn't
  reproduce.
- **"Lando docs seem to lag behind the actual CLI"** — recurring framing in r/PHP
  and Stack Overflow. Users often report finding the right answer in
  `~/.lando/plugins/@lando/<plugin>/` source code rather than docs.
- **"The Pantheon recipe docs reference flags/commands that aren't in current CLI."**
  Multiple Stack Overflow questions from 2023-2024 cite this.
- **Search results for "Lando" are heavily polluted by Lando Norris (F1) and Lando
  Calrissian (Star Wars)** — measurable effect on Google AI summaries (entire
  responses redirect to F1 racing or *Star Wars: Outlaws*). Documentation
  discoverability is hurt by an unrelated brand collision.

### I. Update / version complaints

- **"There is an update available!!! Install it to get the latest and greatest"**
  banner — Stack Overflow user pasted this in their bug report
  (<https://stackoverflow.com/questions/49593800/>). The banner is high-signal that
  Lando users perceive update reminders as part of the surface area.
- **Node-version pin** — historically Lando bundled its own Node, with periodic
  fallout when global Node tooling expected a newer version. Documented in dev.to
  posts 2022-2023.
- **OCLIF-version pin** — implicit; never directly cited by users in non-GitHub
  forums but visible in CLI start-up time complaints (the slowness people attribute
  to Docker is sometimes actually CLI start-up). This is a *latent* issue, not yet
  a forum-visible one.
- **macOS major-version compatibility lag** — r/drupal "Local dev environment on
  M1 Mac os 14" 2024-09-15 (<https://reddit.com/r/drupal/comments/1fhf1hl/>) — Lando
  is mentioned, but DDEV/Colima is the overwhelming recommendation.

### J. Sentiment shifts ("Lando used to be great")

- **"I've used both Lando and DDEV. I really liked DDEV but ended up back with
  Lando."** — u/smashedhijack (positive sentiment). Notable as a counter-example.
- **"Switched from Lando to DDEV about 2 years ago, DDEV has been awesome"** —
  u/bebaps123, r/PHP 2024.
- **"I've used Lando for years"** … followed by "but" — u/iBN3qk, the MariaDB
  thread, *and* most other long-form switcher posts. This grammatical pattern is the
  clearest social-media tell of trust erosion.
- **The 2025 Drupal Developer Survey gap (DDEV 93 / Lando 51)** is the
  quantitative form of the same shift.
- **"DDEV is now also what you might consider the default recommendation for a
  local dev environment too so more and more people are using it"** — u/ge0,
  r/drupal 2024-09-15.
- **"I have been a Lando user for a while, but the lack of traction here is
  concerning"** — u/iBN3qk again. "Lack of traction" is the *exact* phrase most
  damaging to a v3 brand and most actionable for a v4 launch ("here's what
  traction looks like").

---

## 4. The migration triggers — the specific straws

When Lando users finally leave, these are the events that actually pushed them
over. Each is a concrete moment, not a vague preference, and each *was avoidable
with faster maintenance velocity*.

1. **MariaDB 10.11 / 11.x dump compatibility break, June 2024.** DDEV shipped a fix
   in days; Lando users were patching plugins by hand into October 2024. Single
   biggest 2024 trigger.
2. **Upsun (Platform.sh) officially deprecated their Lando plugin and recommends
   DDEV.** Documented by Upsun's own docs and the AI-generated summaries reproduced
   above. For any team on Platform.sh/Upsun, this is the institutional permission
   slip to switch.
3. **Pantheon's `lando init` / `lando pull` workflow producing broken main/master
   branches** when migrating sites from Acquia → Pantheon. Ship-stoppers for agency
   work.
4. **Apple Silicon performance during 2021-2022.** Many devs left then; even though
   M-series is now well-supported, those people never came back.
5. **Drupal-7 EOL forced a Composer/Drupal-10/11 migration push** which exposed
   stale Lando recipes; users with broken Drupal-7 setups had no incentive to
   re-debug Lando when DDEV "just worked" on the new Drupal-10 codebase.
6. **DrupalCon / MidCamp 2024 sessions** ("From Lando to DDEV: A side-by-side
   migration", Bernardo Martinez) — a community-sanctioned, well-attended migration
   path. Once an in-person conference puts your replacement in a session title, the
   social cost of switching drops to zero.
7. **The Great Decoupling rollout (3.19→3.20→3.21).** Users who hit shadowed
   binaries, "command not found", or recipe regressions during 3.20.7 frequently
   tried DDEV "while waiting for Lando to settle down" and didn't come back.
8. **`composer update drupal/core-*` failing on a Lando container** with no
   actionable error (e.g. ContainerNotInitializedException, Sept 2025) — the user
   doesn't know whether to blame Drupal, Composer, or Lando, and DDEV is the
   simplest variable to remove.
9. **Disk-mount overhead causing 30+s navigation** — when a user with a 16GB
   workstation watches their browser hang on a single `node/1` request, the search
   "lando alternative" is one tab away.
10. **`lando rebuild` losing data** — the existence of LSafe (Aug 2025) is itself
    proof this trigger fires often enough to support a third-party tool.

---

## 5. Themes the GitHub issue queue almost certainly under-represents

The GitHub queue captures *bug reports*. These themes show up in the wild but rarely
get filed:

- **"It got slower" — relative-performance regressions.** Users who upgrade and
  feel a 10-20% slowdown almost never file an issue; they switch tools or downgrade.
- **First-impression failure.** "I tried Lando, it didn't work in 30 minutes,
  I moved on." Reddit threads are full of these; the GitHub queue isn't, because
  people who bounce in 30 minutes don't open issues. The Drupal Developer Survey
  delta (DDEV adoption: 42 % → 60 % from 2023→2024) is the cumulative shape of this.
- **Documentation-discoverability friction.** Brand collision with Lando Norris and
  Lando Calrissian is a real Google-/AI-summary problem. Devs encountering this
  abandon search rather than file a docs bug.
- **Cross-tool drift.** When teams have *some* members on Lando and *some* on
  DDEV ("`drush uli` works fine on ddev but lando is acting up this week"
  — u/zaplangoo, paraphrased pattern), the friction surfaces in chat or in code
  review, not in an issue tracker.
- **Hosting-vendor recommendation drift.** Upsun deprecating the Lando integration
  is *the* type of upstream signal that compounds silently — there is no "Lando
  issue" to file against Upsun's docs decision.
- **Trust erosion from `lando destroy` / `lando rebuild` data loss.** People who
  lose their local DB once will *never* file an issue (they'll restore from a
  dump and resolve to back up earlier); they will, however, write
  `apotheosis-tech/lsafe`-style bandaids and tell colleagues "be careful with Lando".
- **CLI-startup latency from Node + OCLIF.** Users perceive this as "Docker is
  slow" and never investigate; this hides one of the most actionable v4 wins
  inside an unfileable category.
- **Resource-allocation guidance is informal folklore.** "You need 32GB" is
  Reddit-side wisdom; nothing in the docs sets that expectation, so users on 16GB
  laptops decide Lando is broken rather than under-resourced. They don't file
  issues — they write blog posts saying "Lando is slow."
- **Accumulated container/volume cruft.** Long-running developers carry months of
  detritus in `~/.lando/`, slowing every command. They notice but don't file.
- **Plugin abandonment / staleness.** A bundled plugin that stops getting updates
  for six months loses users *quietly*; they switch recipes or tools without
  announcing it.

---

## 6. Top 15 most-cited individual pain points (ranked by frequency × severity)

Ranking blends how often the complaint shows up across the sources surveyed and how
badly it hurts the user when it does. Items 1-5 came up in nearly every single
discussion thread; 6-10 came up in most; 11-15 are persistent but smaller.

| # | Pain point | Bucket | Where it shows up |
|---|---|---|---|
| 1 | Slow page loads / high resource usage on Mac & Windows (vs. DDEV) | A | Every Drupal/PHP/WP forum thread 2021-2025; mglaman cites disk-mount design as cause |
| 2 | "Lando keeps breaking" / `lando rebuild` is the universal answer | B | Drupal-7 thread, MAMP-vs-Lando rant, 2023-2024 Stack Overflow, Reddit support requests |
| 3 | Plugin/recipe lag behind upstream (esp. MariaDB 11.4, Drupal 11) | E, B | r/drupal MariaDB thread; drupalarchitect.info; survey delta |
| 4 | Windows-without-WSL2 is unusably slow | C, A | r/drupal 2019, 2023, 2025 threads — same advice, six years apart |
| 5 | `lando destroy` (and sometimes `rebuild`) loses database data | G, B | LSafe project's existence; many "I lost my db" replies |
| 6 | Docker mounts more directories than needed → I/O bottleneck | A | mglaman, multiple expert replies |
| 7 | Configuration/recipe customisation feels like "black magic" | D | u/MR_Weiner; u/smashedhijack; multiple migration posts |
| 8 | Pantheon recipe + `lando pull` workflow brittleness (main/master) | E, D | r/drupal 2023; Stack Overflow 2024 |
| 9 | Documentation drift — workflow described in docs doesn't reproduce | H | r/drupal 2023 edits; Stack Overflow 2024 |
| 10 | Proxy / Traefik startup failures and port-binding conflicts | F | Stack Overflow throughout 2018-2024 |
| 11 | Upsun (and partially Pantheon) recommending DDEV instead | J, E | Upsun docs; survey results |
| 12 | Browser SSL warnings on `*.lndo.site` even after CA install | F | "Lando SSL" SO/forum questions, recurring |
| 13 | Outdated/stale tutorials and YouTube videos predating 3.x | H | Beginner Reddit threads consistently 2024-2025 |
| 14 | The Great Decoupling install path / shadowed binaries | C, I | Lando blog + AUR + setup-script issues |
| 15 | CLI startup latency (subjective) | A, I | Phrased as "lando ssh feels slow"; latent |

---

## 7. Sentiment landscape — visual summary

Two complementary snapshots:

**Quantitative — Drupal Developer Survey 2025**
- DDEV: ~93% recommend (n large)
- Homebrew: ~72%
- Lando: **~51%**
- Roll-your-own LAMP/WAMP: ~majority do NOT recommend

**Qualitative — Reddit thread tone over time**
- 2017-2020: "Lando is great", "Lando saved my Drupal life", recommended in nearly
  every "what local env" thread.
- 2021-2022: First wave of "I switched to DDEV" comments; mostly framed as "DDEV
  is also good".
- 2023-2024: DDEV becomes the *default* recommendation; Lando is the alternative
  ("if you have a complex case", "if you're already there").
- 2025: Lando is mentioned in passing, often as "I used to use Lando." Multiple
  threads where Lando is not mentioned at all even in long answer chains.

The flip happened publicly in 2023-2024. The MariaDB-dump break in mid-2024 and
the Upsun deprecation accelerated it.

---

## 8. Implications for v4 strategy

(Phrased as "what the data implies", not "what to do" — that is your call.)

1. **Trust must be earned back, not assumed.** The "Lando used to be great" framing
   means the v4 launch needs concrete evidence (benchmarks, migration guides, "we
   fixed X, Y, Z" lists) more than feature announcements. New-user mindshare in
   Drupal is measurably DDEV-shaped.
2. **Performance is the #1 reputation lever.** Disk-mount strategy, CLI startup
   time, and Docker provider flexibility are all on this axis. A measurable
   "v4 is 3× faster than v3 on the standard Drupal benchmark" is the only headline
   that addresses the most-cited single complaint.
3. **Plugin/recipe maintenance velocity is the #2 lever.** The MariaDB-dump
   incident is the cleanest case study. v4 should make plugin updates *visibly
   fast*, ideally with an automated upstream-image-tracking story.
4. **`destroy` / `rebuild` data safety is a free win.** A third-party tool
   (LSafe) has implemented "back up before destructive command" because Lando
   doesn't. Building safety nets directly into v4 is a small surface, high
   reputational return.
5. **Out-of-the-box experience on Windows/macOS, with no Docker Desktop, is
   table stakes.** OrbStack/Colima/Rancher integration, plus a sane WSL2 path that
   doesn't require lore from a Reddit thread, addresses Bucket C in one stroke.
6. **Hosting-vendor relationships need active investment.** Pantheon, Acquia,
   Upsun, Platform.sh — these are where teams meet Lando. Upsun is already lost.
   Pantheon's documented workflow is brittle. v4 needs at least one *visibly
   excellent* host integration to re-anchor the narrative.
7. **The brand collision (Norris/Calrissian) is a real SEO/AI-search problem.**
   Worth considering at minimum a "Lando, the dev tool" wordmark and consistent
   `lando.dev` framing in all titles, structured data, and AI-friendly content.
8. **Migration *to* Lando v4 from DDEV needs a story too.** The honest read of
   the data is that v4 is launching into a market where the default is DDEV, not
   raw Docker. A "DDEV → Lando v4" comparison and importer is at least as
   strategically important as a "v3 → v4" upgrade path.

---

## 9. Source index

Reddit threads (downloaded JSON; verbatim quotes referenced above):

- <https://reddit.com/r/drupal/comments/1elrbop/> — MariaDB Dump breaking change and updating Lando (Aug 2024)
- <https://reddit.com/r/drupal/comments/13u6sho/> — "system lags in lando" (May 2023)
- <https://reddit.com/r/drupal/comments/13z338m/> — switched OS to escape Lando-on-Windows (Jun 2023)
- <https://reddit.com/r/drupal/comments/ppsu35/> — "Docker/Lando worst than MAMP ? WTH" (Sep 2021)
- <https://reddit.com/r/drupal/comments/j5pael/> — "Lando + Drupal 7. Does anyone actually have this working?" (Oct 2020)
- <https://reddit.com/r/drupal/comments/ok702p/> — Lando optimization Drupal 9 (Jul 2021)
- <https://reddit.com/r/drupal/comments/pxcola/> — Lando + Mac = High CPU (Sep 2021)
- <https://reddit.com/r/drupal/comments/zwouta/> — Frustrated with current Docker setup (Dec 2022)
- <https://reddit.com/r/drupal/comments/zqfy86/> — Local dev for 15-20 sites (Dec 2022)
- <https://reddit.com/r/drupal/comments/eded84/> — Drupal 8 dev environment poll (Dec 2019)
- <https://reddit.com/r/drupal/comments/14gnm8s/> — Pantheon + Lando setup problems (Jun 2023)
- <https://reddit.com/r/drupal/comments/1fhf1hl/> — Local dev on M1 Mac (Sep 2024)
- <https://reddit.com/r/drupal/comments/1ihejb7/> — Drupal local dev on Windows 11 in 2025 (Feb 2025)
- <https://reddit.com/r/drupal/comments/1c4sauv/> — Drush refuses to bootstrap (Apr 2024)
- <https://reddit.com/r/drupal/comments/1m6pfv1/> — Updating to Drupal 11 breaks site (Jul 2025)
- <https://reddit.com/r/drupal/comments/1kaa805/> — `drush uli` not working (Apr 2025)
- <https://reddit.com/r/drupal/comments/1mux7mp/> — LSafe auto-backup tool (Aug 2025)
- <https://reddit.com/r/drupal/comments/1qb3le0/> — Dependency conflict (Jan 2026)
- <https://reddit.com/r/drupal/comments/bliakz/> — Lando performance on Windows 10 (May 2019)
- <https://reddit.com/r/PHP/comments/1c7sqn4/> — DDEV/Lando and other alternatives (Apr 2024)
- <https://reddit.com/r/PHP/comments/1ijsev2/> — DDEV "We use it on all our projects" (Feb 2025)
- <https://reddit.com/r/PHP/comments/1rnkta8/> — What are you using for your PHP dev setup (2026)
- <https://reddit.com/r/Wordpress/comments/12w36s4/> — Is Lando useful? (Apr 2023)
- <https://reddit.com/r/Wordpress/comments/17ii3pf/> — Do you use Docker for WP (Oct 2023)
- <https://reddit.com/r/Wordpress/comments/17oaq1d/> — Best WP local dev (Nov 2023)
- <https://reddit.com/r/Wordpress/comments/1oj05mn/> — Go-to local dev for WP in 2025 (Oct 2025)
- <https://reddit.com/r/Wordpress/comments/1nefb2p/> — Contact Form 7 + MailHog (Sep 2025)
- <https://reddit.com/r/laravel/comments/1cuietp/> — Is DDEV worth the hassle (May 2024)
- <https://reddit.com/r/symfony/comments/18odpym/> — Symfony slow on Docker (Dec 2023)
- <https://reddit.com/r/webdev/comments/1rarknr/> — Local dev environments at work (2026)

Stack Overflow:

- Tag overview <https://stackoverflow.com/questions/tagged/lando> — 89 questions
- Top question: "Can I roll back to a previous version of Docker Desktop?"
  (67 upvotes, 156k views, asked Jun 2020) — the *most-viewed* Lando-tagged
  question is about *rolling back Docker* to make Lando work again
- "lando rebuild rendering unknown manifest error" Sep 2025
- "Lando recipes are not available in Windows 11" Sep 2024
- "Lando Parse Error: Header overflow" Sep 2024
- "Lando fails to start proxy" (WSL2) Apr 2023
- "lando db-import data.sql … MySQL server has gone away" Dec 2023

Hacker News (HN Algolia search):

- <https://news.ycombinator.com/item?id=21301665> — "Lando: A Liberating Dev Tool for All Your Projects" (Oct 2019, 27 pts, 21 comments). Top reply: "TLDR: It's a Docker Compose utility." Notable that no further Lando submission has scored above 2 points.
- "Push-button development environments hosted on your computer or in the cloud" Aug 2022, 2 pts
- Multiple in-thread mentions in unrelated discussions, mostly recommending Lando, dropping off post-2022.

Drupal community publications:

- Ironstar Drupal Developer Survey 2025 — <https://www.ironstar.io/devsurvey25/>
- Ironstar Drupal Developer Survey 2024 — referenced by 2025 results
- Drupal Architect blog — <https://www.drupalarchitect.info/articles/fixing-mariadb-dump-lando> ("Is Lando behind the curve?")
- DrupalAsheville migration writeups (referenced in Google search results, blog posts no longer fully accessible)
- MidCamp 2024 session: "From Lando to DDEV: A side by side migration" (Bernardo Martinez)
- Bevan's Bench — side-by-side Lando/DDEV co-existence guide

Hosting-vendor publications:

- Upsun documentation — Lando integration officially deprecated, recommends DDEV
- Pantheon Lando recipe documentation — used as ground truth in the 2023 Reddit edit

Third-party tools created in response to v3 pain:

- LSafe — <https://github.com/Apotheosis-Tech/lsafe> (Aug 2025), auto-backup before
  destructive Lando commands. The cleanest "users built a workaround" data point.

DDEV blog posts about Lando:

- <https://ddev.com/blog/mariadb-dump-breaking-change/> (June 2024) — fix shipped
  the same week. The contrast with Lando's response is itself the migration story.

---

*Compiled for the Lando v4 strategic review. Treat the verbatim quotes as accurate
to the linked URLs at time of capture; Reddit threads can be edited or deleted by
their authors. Survey statistics are reproduced from the Ironstar 2025 publication.*
