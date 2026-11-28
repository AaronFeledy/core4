import type { HomeGuideEntry } from "./home-guide-registry.ts";

/**
 * Add a source only if a scenario in its home guide exercises it. Each path
 * or glob must match a Git-visible file.
 *
 * Exception: app-lifecycle.mdx documents data-helper reclamation but does not
 * test it. The map records ownership, not proof of reclamation.
 *
 * Unmapped sources:
 * - Global Mailpit: `global:list` covers it in install-and-bundled-services.mdx,
 *   not in the app-level Mailpit guide.
 * - Apache TLS, MSSQL healthcheck, Nginx config and RabbitMQ probes: the
 *   service guides do not check the listener, healthcheck, config or readiness.
 * - `db:seed`: shown but not run. `lando run --help`: covers the command spec,
 *   not the operation or input parser.
 * - 1Password: the guide inspects config without accessing the store.
 * - Template engines: no scenario. `lando shell`: the guide runs `lando config`.
 * - GitHub Actions planning/contexts/events/actions modules and
 *   `sqlite-recovery-failure.ts`: no guide scenario exercises them.
 *
 * Shared sources without a single home:
 * scratch start, stop, destroy, and logs command specs; core/src/cli/commands/scratch.ts;
 * engine/src/scratch-app/owned-cleanup.ts, destroy.ts, identity.ts, landofile.ts,
 * lifecycle-lock.ts, plan.ts, registry.ts, scanner.ts, service.ts, and
 * teardown-evidence.ts; the remaining plugins/service-lando/src/services/php-*.ts files;
 * logs-input.ts; plugins/proxy-traefik, plugins/ca-mkcert, plugins/renderer-lando,
 * plugins/ssh-agent, plugins/lando3, and plugins/notify-lando; engine/src/operations,
 * engine/src/planner, landofile/src; and bundled recipe sources.
 */
export const HOME_GUIDES: readonly HomeGuideEntry[] = [
  {
    feature: "data-helper-reclaim",
    guide: "docs/guides/tutorial/app-lifecycle.mdx",
    sources: [
      "container-runtime/src/ephemeral-data-helpers.ts",
      "container-runtime/src/helper-owner.ts",
      "container-runtime/src/stale-data-helpers.ts",
    ],
  },
  {
    feature: "scratch-fork",
    guide: "docs/guides/scratch/fork-existing-app.mdx",
    sources: ["engine/src/scratch-app/fork-copy.ts", "engine/src/scratch-app/fork-source.ts"],
  },
  {
    feature: "scratch-gc",
    guide: "docs/guides/scratch/scratch-gc.mdx",
    sources: [
      "engine/src/scratch-app/gc.ts",
      "engine/src/scratch-app/gc-candidates.ts",
      "core/src/cli/command-specs/apps/scratch/gc.ts",
    ],
  },
  {
    feature: "scratch-list-info",
    guide: "docs/guides/scratch/list-and-info.mdx",
    sources: [
      "core/src/cli/command-specs/apps/scratch/list.ts",
      "core/src/cli/command-specs/apps/scratch/info.ts",
      "engine/src/scratch-app/reference.ts",
    ],
  },
  {
    feature: "scratch-mounts-hostnames",
    guide: "docs/guides/scratch/mount-and-share-flags.mdx",
    sources: ["engine/src/scratch-app/mount-isolation.ts", "engine/src/scratch-app/hostnames.ts"],
  },
  {
    feature: "scratch-run",
    guide: "docs/guides/scratch/disposable-tool-runner.mdx",
    sources: ["core/src/cli/command-specs/apps/scratch/run.ts"],
  },
  {
    feature: "scratch-activation",
    guide: "docs/guides/scratch/scratch-from-recipe.mdx",
    sources: ["engine/src/scratch-app/acquisition.ts", "engine/src/scratch-app/startup.ts"],
  },
  {
    feature: "service-adminer",
    guide: "docs/guides/services/adminer.mdx",
    sources: ["plugins/service-lando/src/services/adminer.ts"],
  },
  {
    feature: "service-apache",
    guide: "docs/guides/services/apache.mdx",
    sources: ["plugins/service-lando/src/services/apache.ts"],
  },
  {
    feature: "service-dotnet",
    guide: "docs/guides/services/dotnet.mdx",
    sources: ["plugins/service-lando/src/services/dotnet.ts"],
  },
  {
    feature: "service-elasticsearch",
    guide: "docs/guides/services/elasticsearch.mdx",
    sources: ["plugins/service-lando/src/services/elasticsearch.ts"],
  },
  {
    feature: "service-go",
    guide: "docs/guides/services/go.mdx",
    sources: ["plugins/service-lando/src/services/go.ts"],
  },
  {
    feature: "service-localstack",
    guide: "docs/guides/services/localstack.mdx",
    sources: ["plugins/service-lando/src/services/localstack.ts"],
  },
  {
    feature: "service-mariadb",
    guide: "docs/guides/services/mariadb.mdx",
    sources: ["plugins/service-lando/src/services/mariadb.ts"],
  },
  {
    feature: "service-meilisearch",
    guide: "docs/guides/services/meilisearch.mdx",
    sources: ["plugins/service-lando/src/services/meilisearch.ts"],
  },
  {
    feature: "service-memcached",
    guide: "docs/guides/services/memcached.mdx",
    sources: ["plugins/service-lando/src/services/memcached.ts"],
  },
  {
    feature: "service-minio",
    guide: "docs/guides/services/minio.mdx",
    sources: ["plugins/service-lando/src/services/minio.ts"],
  },
  {
    feature: "service-mongodb",
    guide: "docs/guides/services/mongodb.mdx",
    sources: [
      "plugins/service-lando/src/services/mongodb.ts",
      "plugins/service-lando/src/services/mongodb-probes.ts",
    ],
  },
  {
    feature: "service-mssql",
    guide: "docs/guides/services/mssql.mdx",
    sources: ["plugins/service-lando/src/services/mssql.ts"],
  },
  {
    feature: "service-mysql",
    guide: "docs/guides/services/mysql.mdx",
    sources: ["plugins/service-lando/src/services/mysql.ts"],
  },
  {
    feature: "service-nginx",
    guide: "docs/guides/services/nginx.mdx",
    sources: ["plugins/service-lando/src/services/nginx.ts"],
  },
  {
    feature: "service-node",
    guide: "docs/guides/services/node.mdx",
    sources: [
      "plugins/service-lando/src/services/node.ts",
      "plugins/service-lando/src/services/node-feature.ts",
      "plugins/service-lando/src/services/node-inference.ts",
      "plugins/service-lando/src/services/node-package-manager.ts",
      "plugins/service-lando/src/services/node-package-manager-declaration.ts",
      "plugins/service-lando/src/services/node-package-manager-install.ts",
      "plugins/service-lando/src/services/node-package-manager-spec.ts",
      "plugins/service-lando/src/services/node-service-launchers.ts",
      "plugins/service-lando/src/services/node-tooling.ts",
      "plugins/service-lando/src/services/node-versions.ts",
      "plugins/service-lando/src/services/node-yarn-linker.ts",
    ],
  },
  {
    feature: "service-opensearch",
    guide: "docs/guides/services/opensearch.mdx",
    sources: ["plugins/service-lando/src/services/opensearch.ts"],
  },
  {
    feature: "service-php",
    guide: "docs/guides/services/php.mdx",
    sources: ["plugins/service-lando/src/services/php.ts"],
  },
  {
    feature: "service-phpmyadmin",
    guide: "docs/guides/services/phpmyadmin.mdx",
    sources: ["plugins/service-lando/src/services/phpmyadmin.ts"],
  },
  {
    feature: "service-postgres",
    guide: "docs/guides/services/postgres.mdx",
    sources: ["plugins/service-lando/src/services/postgres.ts"],
  },
  {
    feature: "service-python",
    guide: "docs/guides/services/python.mdx",
    sources: [
      "plugins/service-lando/src/services/python.ts",
      "plugins/service-lando/src/services/python-dependency-environment.ts",
      "plugins/service-lando/src/services/python-local-launcher.ts",
    ],
  },
  {
    feature: "service-rabbitmq",
    guide: "docs/guides/services/rabbitmq.mdx",
    sources: ["plugins/service-lando/src/services/rabbitmq.ts"],
  },
  {
    feature: "service-redis",
    guide: "docs/guides/services/redis.mdx",
    sources: ["plugins/service-lando/src/services/redis.ts"],
  },
  {
    feature: "service-ruby",
    guide: "docs/guides/services/ruby.mdx",
    sources: [
      "plugins/service-lando/src/services/ruby.ts",
      "plugins/service-lando/src/services/ruby-local-launcher.ts",
    ],
  },
  {
    feature: "service-solr",
    guide: "docs/guides/services/solr.mdx",
    sources: ["plugins/service-lando/src/services/solr.ts"],
  },
  {
    feature: "service-static",
    guide: "docs/guides/services/static.mdx",
    sources: ["plugins/service-lando/src/services/static.ts"],
  },
  {
    feature: "service-tomcat",
    guide: "docs/guides/services/tomcat.mdx",
    sources: ["plugins/service-lando/src/services/tomcat.ts"],
  },
  {
    feature: "service-valkey",
    guide: "docs/guides/services/valkey.mdx",
    sources: ["plugins/service-lando/src/services/valkey.ts"],
  },
  {
    feature: "service-varnish",
    guide: "docs/guides/services/varnish.mdx",
    sources: ["plugins/service-lando/src/services/varnish.ts"],
  },
  {
    feature: "service-mailpit",
    guide: "docs/guides/services/mailpit.mdx",
    sources: [
      "plugins/service-lando/src/services/mailpit.ts",
      "plugins/service-lando/src/services/mailhog.ts",
      "plugins/service-lando/src/app-features/mailpit.ts",
      "plugins/service-lando/src/mailpit-constants.ts",
    ],
  },
  {
    feature: "service-compose",
    guide: "docs/guides/services/compose-passthrough.mdx",
    sources: ["plugins/service-lando/src/services/compose.ts"],
  },
  {
    feature: "php-xdebug",
    guide: "docs/guides/tooling/xdebug-phpstorm.mdx",
    sources: ["plugins/service-lando/src/services/php-xdebug.ts"],
  },
  {
    feature: "db-commands",
    guide: "docs/guides/tooling/db-import-export.mdx",
    sources: [
      "plugins/sql/src/commands/export.ts",
      "plugins/sql/src/commands/import.ts",
      "plugins/sql/src/commands/prune.ts",
      "plugins/sql/src/commands/reset.ts",
      "plugins/sql/src/commands/restore.ts",
      "plugins/sql/src/commands/snapshot.ts",
      "plugins/sql/src/commands/snapshots.ts",
      "core/src/cli/command-specs/meta/snapshots/gc.ts",
      "plugins/sql/src/recovery.ts",
      "plugins/sql/src/recovery-target.ts",
      "plugins/sql/src/recovery-adoption.ts",
    ],
  },
  {
    feature: "db-creds-apply",
    guide: "docs/guides/tooling/db-creds-apply.mdx",
    sources: ["plugins/sql/src/commands/creds-apply.ts", "plugins/sql/src/admin-password.ts"],
  },
  {
    feature: "db-sqlite",
    guide: "docs/guides/tooling/sqlite-database.mdx",
    sources: [
      "plugins/sql/src/sqlite-archive.ts",
      "plugins/sql/src/sqlite-command-preparation.ts",
      "plugins/sql/src/sqlite-dump.ts",
      "plugins/sql/src/sqlite-execute.ts",
      "plugins/sql/src/sqlite-export-destination.ts",
      "plugins/sql/src/sqlite-header.ts",
      "plugins/sql/src/sqlite-helper-files.ts",
      "plugins/sql/src/sqlite-helper-run.ts",
      "plugins/sql/src/sqlite-helper.ts",
      "plugins/sql/src/sqlite-import-payload.ts",
      "plugins/sql/src/sqlite-integrity.ts",
      "plugins/sql/src/sqlite-mount.ts",
      "plugins/sql/src/sqlite-mutation-control.ts",
      "plugins/sql/src/sqlite-mutation.ts",
      "plugins/sql/src/sqlite-path.ts",
      "plugins/sql/src/sqlite-retention.ts",
      "plugins/sql/src/sqlite-snapshot-capture.ts",
      "plugins/sql/src/sqlite-snapshot-transfer.ts",
      "plugins/sql/src/sqlite-snapshot.ts",
      "plugins/sql/src/sqlite-suspension.ts",
      "plugins/sql/src/applied-sqlite.ts",
    ],
  },
  {
    feature: "schedule",
    guide: "docs/guides/services/schedule.mdx",
    sources: ["plugins/schedule/src/**/*.ts"],
  },
  {
    feature: "github-actions-inspection",
    guide: "docs/guides/plugins/github-actions-inspection.mdx",
    sources: [
      "plugins/github-actions/src/acquisition.ts",
      "plugins/github-actions/src/bounded-read.ts",
      "plugins/github-actions/src/diagnostics.ts",
      "plugins/github-actions/src/errors.ts",
      "plugins/github-actions/src/inspect.ts",
      "plugins/github-actions/src/language/errors.ts",
      "plugins/github-actions/src/language/parse.ts",
      "plugins/github-actions/src/language/preflight.ts",
      "plugins/github-actions/src/list.ts",
      "plugins/github-actions/src/operations.ts",
      "plugins/github-actions/src/preflight.ts",
      "plugins/github-actions/src/projection.ts",
      "plugins/github-actions/src/schema.ts",
      "plugins/github-actions/src/source-context.ts",
    ],
  },
  {
    feature: "cli-poweroff",
    guide: "docs/guides/cli/poweroff.mdx",
    sources: ["core/src/cli/command-specs/apps/poweroff.ts"],
  },
  {
    feature: "cli-sources-gc",
    guide: "docs/guides/cli/sources-gc.mdx",
    sources: ["core/src/cli/command-specs/meta/sources/gc.ts"],
  },
  {
    feature: "cli-cache-refresh",
    guide: "docs/guides/cli/cache-refresh.mdx",
    sources: ["core/src/cli/command-specs/app/cache/refresh.ts"],
  },
  {
    feature: "cli-ssh",
    guide: "docs/guides/cli/ssh.mdx",
    sources: ["core/src/cli/command-specs/app/ssh.ts"],
  },
  {
    feature: "cli-exec",
    guide: "docs/guides/cli/exec.mdx",
    sources: ["core/src/cli/command-specs/app/exec.ts"],
  },
  {
    feature: "cli-config-explain",
    guide: "docs/guides/landofile/config-explain.mdx",
    sources: ["core/src/cli/command-specs/app/config/explain.ts"],
  },
  {
    feature: "cli-logs",
    guide: "docs/guides/cli/service-logs.mdx",
    sources: ["core/src/cli/command-specs/app/logs.ts"],
  },
  {
    feature: "cli-config-lint",
    guide: "docs/guides/landofile/config-lint.mdx",
    sources: ["core/src/cli/command-specs/app/config/lint.ts"],
  },
  {
    feature: "cli-config-translate",
    guide: "docs/guides/landofile/config-translate.mdx",
    sources: ["core/src/cli/command-specs/app/config/translate.ts"],
  },
  {
    feature: "cli-config-migrate",
    guide: "docs/guides/recipes/migrating-recipes.mdx",
    sources: ["core/src/cli/command-specs/app/config/migrate.ts"],
  },
  {
    feature: "cli-mcp",
    guide: "docs/guides/agent-native/mcp.mdx",
    sources: ["core/src/cli/command-specs/meta/mcp.ts"],
  },
];
