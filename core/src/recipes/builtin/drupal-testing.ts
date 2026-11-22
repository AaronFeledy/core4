import type { RecipeConfigLayer } from "@lando/sdk/schema";

export const DRUPAL_CHROME_IMAGE = "selenium/standalone-chromium:155.0-20261010";

const chrome = {
  type: "compose",
  image: DRUPAL_CHROME_IMAGE,
  appMount: false,
  home: false,
  shm_size: "2gb",
  healthcheck: {
    kind: "command",
    command: ["/opt/bin/check-grid.sh"],
    intervalSeconds: 5,
    retries: 24,
  },
} as const;

export const drupalDatabaseUrl = (driver: "mysql" | "pgsql") =>
  `${driver}://{{ url.encodeComponent(services.database.creds.user) }}:{{ url.encodeComponent(services.database.creds.password) }}@database:{{ services.database.port }}/{{ url.encodeComponent(services.database.creds.database) }}`;

export const drupalSimpletestBaseUrl = (service: "appserver" | "edge") =>
  service === "appserver" ? "http://appserver:{{ service.port }}" : "http://edge:{{ services.edge.port }}";

export const drupalTestingConfig = (webroot: string) =>
  ({
    services: {
      chrome,
      appserver: {
        depends_on: ["database", "chrome"],
        environment: {
          SIMPLETEST_BASE_URL: drupalSimpletestBaseUrl("appserver"),
          SIMPLETEST_DB: drupalDatabaseUrl("mysql"),
          BROWSERTEST_OUTPUT_DIRECTORY: `${webroot}/sites/simpletest/browser_output`,
          MINK_DRIVER_ARGS_WEBDRIVER:
            '["chrome", {"browserName":"chrome","goog:chromeOptions":{"w3c":true,"args":["--headless=new","--disable-gpu","--no-sandbox"]}}, "http://chrome:4444"]',
        },
      },
    },
    tooling: {
      phpunit: {
        service: "appserver",
        user: "www-data",
        description: "Run Drupal PHPUnit tests as the web server user, from your current directory.",
        cmd: ["/app/vendor/bin/phpunit", "-c", `${webroot}/core`],
        wrapper: true,
      },
    },
  }) as const;

export const drupalTestingOverrides = (optIn: boolean) =>
  [
    {
      when: optIn
        ? '{{ and(options.testing, eq(options.webserver, "nginx")) }}'
        : '{{ eq(options.webserver, "nginx") }}',
      config: {
        services: { appserver: { environment: { SIMPLETEST_BASE_URL: drupalSimpletestBaseUrl("edge") } } },
      },
    },
    {
      when: optIn
        ? '{{ and(options.testing, eq(options.database, "postgres:16")) }}'
        : '{{ eq(options.database, "postgres:16") }}',
      config: { services: { appserver: { environment: { SIMPLETEST_DB: drupalDatabaseUrl("pgsql") } } } },
    },
  ] as const satisfies readonly RecipeConfigLayer[];

export const drupalSiteTestingVariants = (variants: readonly RecipeConfigLayer[]) =>
  [
    ...variants.map(({ config, when }) => ({
      when,
      config: {
        ...config,
        services: {
          ...config.services,
          ...siteTesting.services,
          appserver: { ...config.services?.appserver, ...siteTesting.services.appserver },
        },
        tooling: { ...config.tooling, ...siteTesting.tooling },
      },
    })),
    ...drupalTestingOverrides(true),
  ] as const satisfies readonly RecipeConfigLayer[];

const siteTesting = drupalTestingConfig('{{ path.resolve("/app", recipe.webroot) }}');
