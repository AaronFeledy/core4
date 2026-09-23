/**
 * Independent, test-only ownership ledger. Patterns own descendants, not siblings;
 * only a complete `*` segment is a wildcard. Names are source modules, not tickets.
 * Dispositions describe the positive case; value-dependent rejection cases live
 * beside it (e.g. a portable recipe versus a hosting-platform recipe).
 * allow: SIZE_OK — declarative inventory data, deliberately kept in one fixture.
 */
export interface Golden {
  readonly name: string;
  readonly yaml: string;
  readonly expect:
    | {
        readonly kind: "rewritten" | "generated" | "dropped" | "needs-review" | "unsupported";
        readonly keyPath: ReadonlyArray<string | number>;
      }
    | { readonly outputPath: ReadonlyArray<string>; readonly value?: unknown };
}
export interface DispositionEntry {
  readonly pattern: ReadonlyArray<string>;
  readonly disposition: "target" | "drop" | "unsupported";
  readonly owner: string;
  readonly golden: ReadonlyArray<Golden>;
}
const diagnostic = (
  yaml: string,
  kind: Extract<Golden["expect"], { readonly kind: string }>["kind"],
  keyPath: ReadonlyArray<string | number>,
): Golden => ({
  name: `${kind} ${JSON.stringify(keyPath)}`,
  yaml,
  expect: { kind, keyPath },
});
const output = (yaml: string, outputPath: ReadonlyArray<string>, value: unknown): Golden => ({
  name: `output ${JSON.stringify(outputPath)}`,
  yaml,
  expect: { outputPath, value },
});
const service = (fields: string, name = "s") => `name: inventory\nservices:\n  ${name}: {${fields}}\n`;
const api4 = (fields: string, name = "s") =>
  service(`api: 4, ${fields.startsWith("image:") ? "" : "image: 'nginx:1.27', "}${fields}`, name);
const tooling = (fields: string) => `tooling:\n  task: {cmd: echo ok, ${fields}}\n`;
const recipe = (fields: string) => `recipe: drupal10\nconfig: {${fields}}\n`;

// Literal lists are intentional: deriving rows from the fixtures would hide new inventory gaps.
const globalDrops = [
  "domain",
  "proxyName",
  "proxyHttpPort",
  "proxyHttpsPort",
  "proxyHttpFallbacks",
  "proxyHttpsFallbacks",
  "proxyBindAddress",
  "proxyPassThru",
  "proxyDefaultCert",
  "proxyDefaultKey",
  "proxyCache",
  "proxyCommand",
  "proxyCustom",
  "bindAddress",
  "networkBridge",
  "networkLimit",
  "engineConfig",
  "dockerBin",
  "orchestratorVersion",
  "orchestratorBin",
  "orchestratorSeparator",
  "dockerSupportedVersions",
  "appEnv",
  "appLabels",
  "maxKeyWarning",
  "disablePlugins",
  "experimental",
  "alliance",
  "setup",
  "channel",
  "stats",
  "logLevel",
  "logLevelConsole",
  "logDir",
  "mode",
  "isInteractive",
  "userAgent",
] as const;
export const referenceVariants = [
  "cli:lando pull",
  "cli:lando push",
  "cli:lando share",
  "cli:lando info --deep",
  "cli:lando info --filter",
  "cli:lando info -s",
  "cli:lando rebuild -s",
  "cli:lando logs -t",
  "cli:lando version --all",
  "cli:lando version --component",
  "cli:lando list",
  "cli:lando <other>",
  "env:LANDO_INFO",
  "env:LANDO_MOUNT",
  "env:settings.lando.php",
  "env:wp-config",
] as const;

export const dispositionInventory: ReadonlyArray<DispositionEntry> = [
  {
    pattern: ["name"],
    disposition: "target",
    owner: "translator",
    golden: [output("name: Inventory App\n", ["name"], "inventory-app")],
  },
  {
    pattern: ["recipe"],
    disposition: "target",
    owner: "recipe-lowering",
    golden: [
      output("recipe: drupal10\n", ["recipe", "id"], "drupal"),
      ...["pantheon", "platformsh", "lagoon", "acquia"].map((id) =>
        diagnostic(`recipe: ${id}\n`, "unsupported", ["recipe"]),
      ),
    ],
  },
  {
    pattern: ["config"],
    disposition: "target",
    owner: "recipe-options",
    golden: [output(recipe("php: '8.2'"), ["recipe", "options", "php"], "8.2")],
  },
  ...(
    [
      ["php", "'8.2'", "php", "8.2"],
      ["via", "nginx", "webserver", "nginx"],
      ["webroot", "/app/public", "webroot", "/app/public"],
      ["database", "postgres:16", "database", "postgres:16"],
      ["composer_version", "'2.7.7'", "composer", "2.7.7"],
    ] as const
  ).map(
    ([key, value, target, expected]): DispositionEntry => ({
      pattern: ["config", key],
      disposition: "target",
      owner: "recipe-options",
      golden: [output(recipe(`${key}: ${value}`), ["recipe", "options", target], expected)],
    }),
  ),
  ...[
    "xdebug",
    "ssl",
    "drush",
    "build",
    "config",
    "bee",
    "cache",
    "node",
    "port",
    "framework",
    "site",
    "id",
    "index",
    "edge",
    "acli_version",
    "ah_application_uuid",
    "ah_site_group",
    "inbox",
  ].map(
    (key): DispositionEntry => ({
      pattern: ["config", key],
      disposition: "drop",
      owner: "recipe-options",
      golden: [diagnostic(recipe(`${key}: false`), "dropped", ["config", key])],
    }),
  ),
  {
    pattern: ["compose"],
    disposition: "target",
    owner: "lower-top-level",
    golden: [output("compose: [compose.yml]\n", ["includes"], [{ source: "compose.yml", kind: "compose" }])],
  },
  {
    pattern: ["excludes"],
    disposition: "target",
    owner: "lower-top-level",
    golden: [diagnostic("excludes: [vendor, '!vendor/keep']\n", "rewritten", ["excludes"])],
  },
  ...["keys", "plugins", "pluginDirs"].map(
    (key): DispositionEntry => ({
      pattern: [key],
      disposition: "drop",
      owner: "lower-top-level",
      golden: [diagnostic(`${key}: []\n`, "dropped", [key])],
    }),
  ),
  ...(
    [
      ["env_file", "[.env]", [".env"]],
      ["volumes", "{data: null}", { data: {} }],
      ["networks", "{net: null}", { net: {} }],
      ["x-vars", "[test]", ["test"]],
      ["x-service", "{api: 4}", { api: 4 }],
    ] as const
  ).map(
    ([key, yaml, value]): DispositionEntry => ({
      pattern: [key],
      disposition: "target",
      owner: "lower-top-level",
      golden: [output(`${key}: ${yaml}\n`, [key], value)],
    }),
  ),
  ...globalDrops.map(
    (key): DispositionEntry => ({
      pattern: [key],
      disposition: "drop",
      owner: "lower-top-level",
      golden: [
        diagnostic(`${key}: true\n`, "dropped", [key]),
        ...(key === "mode"
          ? ["command", "landoFileConfig", "not-a-lando-key"].map((extra) =>
              diagnostic(`${extra}: true\n`, "dropped", [extra]),
            )
          : []),
      ],
    }),
  ),
  ...["landoFile", "preLandoFiles", "postLandoFiles"].map(
    (key): DispositionEntry => ({
      pattern: [key],
      disposition: "drop",
      owner: "lower-top-level",
      golden: [
        diagnostic(`${key}: ${key === "landoFile" ? ".custom.yml" : "[.custom.yml]"}\n`, "needs-review", [
          key,
        ]),
      ],
    }),
  ),
  ...["pluginConfig", "pluginConfigFile"].map(
    (key): DispositionEntry => ({
      pattern: [key],
      disposition: "unsupported",
      owner: "lower-top-level",
      golden: [diagnostic(`${key}: private\n`, "unsupported", [key])],
    }),
  ),
  {
    pattern: ["services"],
    disposition: "target",
    owner: "service-lowering",
    golden: [output(service("type: node:22"), ["services", "s", "type"], "node:22")],
  },
  {
    pattern: ["services", "*", "api"],
    disposition: "target",
    owner: "service-lowering",
    golden: [output(api4("command: echo ok"), ["services", "s", "type"], "lando")],
  },
  {
    pattern: ["services", "*", "type"],
    disposition: "target",
    owner: "lower-catalog-common",
    golden: [
      output(service("type: mongo:7"), ["services", "s", "type"], "mongodb:7"),
      diagnostic(service("type: php:8.3"), "needs-review", ["services", "s", "type"]),
    ],
  },
  ...(
    [
      ["via", "nginx", "via", "fpm"],
      ["webroot", "web", "webroot", "/app/web"],
      ["composer_version", "'2.7.7'", "composer", { version: "2.7.7" }],
      ["composer", "{phpunit/phpunit: '^11'}", "composer", { packages: { "phpunit/phpunit": "^11" } }],
      ["db_client", "mysql:8.4", "db_client", "mysql:8.4"],
    ] as const
  ).map(
    ([key, value, target, expected]): DispositionEntry => ({
      pattern: ["services", "*", key],
      disposition: "target",
      owner: "lower-php",
      golden: [output(service(`type: php:8.3, ${key}: ${value}`), ["services", "s", target], expected)],
    }),
  ),
  {
    pattern: ["services", "*", "xdebug"],
    disposition: "target",
    owner: "lower-php",
    golden: [
      output(service("type: php:8.3, xdebug: {mode: debug}"), ["services", "s", "xdebug"], "debug"),
      diagnostic(service("type: php:8.3, xdebug: {mode: debug}"), "rewritten", ["services", "s", "xdebug"]),
      diagnostic(service("type: php:8.3, xdebug: {mystery: true}"), "dropped", [
        "services",
        "s",
        "xdebug",
        "mystery",
      ]),
    ],
  },
  ...["start_with_request", "client_port"].map(
    (key): DispositionEntry => ({
      pattern: ["services", "*", "xdebug", key],
      disposition: "target",
      owner: "lower-xdebug-object",
      golden: [
        diagnostic(
          service(`type: php:8.3, xdebug: {${key}: ${key === "client_port" ? "9003" : "'yes'"}}`),
          "rewritten",
          ["services", "s", "xdebug", key],
        ),
        output(
          service(`type: php:8.3, xdebug: {${key}: ${key === "client_port" ? "9005" : "'yes'"}}`),
          ["services", "s", "environment", "XDEBUG_CONFIG"],
          `client_host=host.docker.internal client_port=${key === "client_port" ? "9005" : "9003 start_with_request=yes"}`,
        ),
      ],
    }),
  ),
  {
    pattern: ["services", "*", "xdebug", "config"],
    disposition: "drop",
    owner: "lower-php",
    golden: [
      diagnostic(service("type: php:8.3, xdebug: {config: {max_nesting_level: 256}}"), "dropped", [
        "services",
        "s",
        "xdebug",
        "config",
        "max_nesting_level",
      ]),
    ],
  },
  ...(
    [
      ["ssl", "true", "certs", true],
      ["port", "3000", "port", 3000],
      ["command", "echo ok", "command", "echo ok"],
      ["user", "root", "user", "root"],
      ["environment", "{VALUE: 123}", "environment", { VALUE: "123" }],
      ["creds", "{database: app}", "creds", { database: "app" }],
      ["portforward", "3307", "ports", ["3307:3306"]],
    ] as const
  ).map(
    ([key, value, target, expected]): DispositionEntry => ({
      pattern: ["services", "*", key],
      disposition: "target",
      owner: "lower-catalog-common",
      golden: [output(service(`type: mysql:8.0, ${key}: ${value}`), ["services", "s", target], expected)],
    }),
  ),
  {
    pattern: ["services", "*", "sport"],
    disposition: "target",
    owner: "lower-catalog-common",
    golden: [
      output(
        service("type: php:8.3, sport: 8443"),
        ["services", "s", "endpoints"],
        [{ _tag: "internal", protocol: "https", port: 8443 }],
      ),
    ],
  },
  {
    pattern: ["services", "*", "sslExpose"],
    disposition: "target",
    owner: "lower-catalog-common",
    golden: [
      output(
        service("type: node:22, ssl: 8443, sslExpose: true"),
        ["services", "s", "endpoints"],
        [{ _tag: "published", protocol: "https", port: 8443, publication: {} }],
      ),
    ],
  },
  {
    pattern: ["services", "*", "app_mount"],
    disposition: "target",
    owner: "lower-catalog-common",
    golden: [
      output(service("type: php:8.3, app_mount: false"), ["services", "s", "appMount"], false),
      diagnostic(service("type: php:8.3, app_mount: cached"), "dropped", ["services", "s", "app_mount"]),
    ],
  },
  ...["path", "scriptsDir", "moreHttpPorts"].map(
    (key): DispositionEntry => ({
      pattern: ["services", "*", key],
      disposition: "drop",
      owner: "lower-catalog-common",
      golden: [diagnostic(service(`type: node:22, ${key}: [test]`), "dropped", ["services", "s", key])],
    }),
  ),
  {
    pattern: ["services", "*", "meUser"],
    disposition: "target",
    owner: "service-lowering",
    golden: [
      output(
        service("type: lando, services: {image: 'nginx:1.27'}, meUser: root"),
        ["services", "s", "user"],
        "root",
      ),
    ],
  },
  {
    pattern: ["services", "*", "scanner"],
    disposition: "target",
    owner: "lower-runtime-intent",
    golden: [
      output(
        service("type: node:22, scanner: {okCodes: [200], retry: 2, timeout: 1000, path: health}"),
        ["services", "s", "scanner"],
        { okCodes: [200], retries: 2, timeout: 3000, path: "/health" },
      ),
    ],
  },
  {
    pattern: ["services", "*", "scanner", "maxRedirects"],
    disposition: "drop",
    owner: "lower-runtime-intent",
    golden: [
      diagnostic(service("type: node:22, scanner: {maxRedirects: 6}"), "dropped", [
        "services",
        "s",
        "scanner",
        "maxRedirects",
      ]),
    ],
  },
  {
    pattern: ["services", "*", "config"],
    disposition: "target",
    owner: "lower-catalog-common",
    golden: [
      diagnostic(service("type: php:8.3, config: {php: php.ini}"), "rewritten", [
        "services",
        "s",
        "config",
        "php",
      ]),
    ],
  },
  {
    pattern: ["services", "raw3", "config", "*"],
    disposition: "unsupported",
    owner: "service-lowering",
    golden: [
      diagnostic(
        service("type: lando, services: {image: nginx}, config: {/tmp/file: contents}", "raw3"),
        "unsupported",
        ["services", "raw3", "config", "/tmp/file"],
      ),
    ],
  },
  ...[
    "build",
    "build_as_root",
    "run",
    "run_as_root",
    "build_internal",
    "run_internal",
    "build_as_root_internal",
    "run_as_root_internal",
  ].map(
    (key): DispositionEntry => ({
      pattern: ["services", "*", key],
      disposition: "target",
      owner: "build-hooks",
      golden: [
        diagnostic(service(`type: node:22, ${key}: [echo ok]`), "rewritten", ["services", "s", "build"]),
      ],
    }),
  ),
  {
    pattern: ["services", "appserver", "build", "2"],
    disposition: "unsupported",
    owner: "build-hooks",
    golden: [
      diagnostic(
        service("type: php:8.3, build: [echo one, echo two, !load missing.sh]", "appserver"),
        "unsupported",
        ["services", "appserver", "build", 2],
      ),
    ],
  },
  ...(
    [
      ["authentication", "mysql:8.0", "mysql_native_password"],
      ["globals", "node:22", "{pnpm: latest}"],
      ["core", "solr:9", "solo"],
      ["hogfrom", "mailhog", "[appserver]"],
      ["maxMessages", "mailpit", "1234"],
      ["backends", "varnish:6", "[appserver]"],
    ] as const
  ).map(
    ([key, type, value]): DispositionEntry => ({
      pattern: ["services", "*", key],
      disposition: "target",
      owner: "lower-type-options",
      golden: [
        diagnostic(service(`type: ${type}, ${key}: ${value}`), "rewritten", ["services", "s", key]),
        ...(key === "backends"
          ? [
              diagnostic(service("type: varnish:6, backends: [one, two]"), "unsupported", [
                "services",
                "s",
                "backends",
              ]),
            ]
          : []),
      ],
    }),
  ),
  ...(
    [
      ["password", "redis:7", "secret", "secret"],
      ["persist", "redis:7", "true", true],
      ["mailFrom", "mailpit", "[appserver]", ["appserver"]],
      ["hosts", "phpmyadmin:5", "[database]", ["database"]],
      ["backend", "varnish:6", "appserver", "appserver"],
    ] as const
  ).map(
    ([key, type, value, expected]): DispositionEntry => ({
      pattern: ["services", "*", key],
      disposition: "target",
      owner: "lower-type-options",
      golden: [output(service(`type: ${type}, ${key}: ${value}`), ["services", "s", key], expected)],
    }),
  ),
  {
    pattern: ["services", "*", "backend_port"],
    disposition: "drop",
    owner: "lower-type-options",
    golden: [
      diagnostic(service("type: varnish:6, backend_port: 8000"), "dropped", [
        "services",
        "s",
        "backend_port",
      ]),
    ],
  },
  {
    pattern: ["services", "*", "mem"],
    disposition: "target",
    owner: "lower-service-memory",
    golden: [
      ...["memcached", "elasticsearch:8", "opensearch:2"].map((type) =>
        diagnostic(
          service(`type: ${type}, mem: ${type.startsWith("memcached") ? "256" : "1024m"}`),
          "rewritten",
          ["services", "s", "mem"],
        ),
      ),
      diagnostic(service("type: node:22, mem: 256"), "dropped", ["services", "s", "mem"]),
      output(
        service("type: memcached, mem: 256"),
        ["services", "s", "command"],
        ["memcached", "-p", "11211", "-m", "256"],
      ),
      ...(
        [
          ["elasticsearch:8", "ES_JAVA_OPTS"],
          ["opensearch:2", "OPENSEARCH_JAVA_OPTS"],
        ] as const
      ).map(([type, key]) =>
        output(
          service(`type: ${type}, mem: 1024m`),
          ["services", "s", "environment", key],
          "-Xms1024m -Xmx1024m",
        ),
      ),
    ],
  },
  {
    pattern: ["services", "*", "plugins"],
    disposition: "unsupported",
    owner: "lower-type-options",
    golden: [
      diagnostic(service("type: elasticsearch:8, plugins: [analysis-icu]"), "unsupported", [
        "services",
        "s",
        "plugins",
      ]),
      diagnostic(service("type: opensearch:2, plugins: [analysis-icu]"), "unsupported", [
        "services",
        "s",
        "plugins",
      ]),
      diagnostic(service("type: node:22, plugins: [analysis-icu]"), "dropped", ["services", "s", "plugins"]),
    ],
  },
  ...["overrides", "services"].map(
    (key): DispositionEntry => ({
      pattern: ["services", "*", key],
      disposition: "target",
      owner: "compose-fields",
      golden: [
        output(
          service(`type: lando, ${key}: {image: 'nginx:1.27'}`),
          ["services", "s", "image"],
          "nginx:1.27",
        ),
        ...["tty", "stdin_open", "links", "network_mode", "container_name"].map((field) =>
          diagnostic(service(`type: lando, ${key}: {image: nginx, ${field}: true}`), "unsupported", [
            "services",
            "s",
            key,
            field,
          ]),
        ),
      ],
    }),
  ),
  {
    pattern: ["services", "*", "overrides", "ports", "*", "mode"],
    disposition: "unsupported",
    owner: "compose-dispositions",
    golden: [
      diagnostic(
        service("type: node:22, overrides: {ports: [{target: 80, published: 8080, mode: host}]}"),
        "unsupported",
        ["services", "s", "overrides", "ports", 0, "mode"],
      ),
    ],
  },
  {
    pattern: ["services", "*", "services", "links"],
    disposition: "unsupported",
    owner: "compose-dispositions",
    golden: [
      diagnostic(service("type: lando, services: {image: nginx, links: [other]}"), "unsupported", [
        "services",
        "s",
        "services",
        "links",
      ]),
    ],
  },
  {
    pattern: ["services", "*", "services", "extra_hosts"],
    disposition: "target",
    owner: "host-reachability",
    golden: [
      diagnostic(
        service("type: lando, services: {image: nginx, extra_hosts: ['host.lando.internal:host-gateway']}"),
        "rewritten",
        ["services", "s", "services", "extra_hosts", 0],
      ),
    ],
  },
  ...(
    [
      ["image", "'nginx:1.27'", "image", "nginx:1.27"],
      ["primary", "true", "primary", true],
      ["working_dir", "/tmp", "workingDirectory", "/tmp"],
      ["hostnames", "[example.test]", "hostnames", ["example.test"]],
      ["certs", "false", "certs", false],
      ["labels", "{team: dev}", "labels", { team: "dev" }],
      ["app-mount", "false", "appMount", false],
      ["mounts", "['./src:/dst']", "mounts", [{ source: "./src", target: "/dst" }]],
      ["storage", "[/data]", "storage", [{ store: "data", target: "/data" }]],
      ["security", "{ca: [ca.crt]}", "security", { ca: ["ca.crt"] }],
      [
        "healthcheck",
        "{command: echo ok, retry: 10, delay: 1000}",
        "healthcheck",
        { command: "echo ok", retries: 10, intervalSeconds: 1 },
      ],
      ["ports", "[8080/http]", "endpoints", [{ _tag: "internal", protocol: "http", port: 8080 }]],
      ["volumes", "['data:/data']", "volumes", ["data:/data"]],
      ["networks", "{net: null}", "networks", { net: null }],
    ] as const
  ).map(
    ([key, value, target, expected]): DispositionEntry => ({
      pattern: ["services", "*", key],
      disposition: "target",
      owner: "lower-api4",
      golden: [output(api4(`${key}: ${value}`), ["services", "s", target], expected)],
    }),
  ),
  {
    pattern: ["services", "*", "persistent-storage"],
    disposition: "target",
    owner: "lower-api4",
    golden: [
      diagnostic(api4("persistent-storage: []"), "rewritten", ["services", "s", "persistent-storage"]),
    ],
  },
  {
    pattern: ["services", "*", "entrypoint"],
    disposition: "unsupported",
    owner: "lower-api4",
    golden: [
      diagnostic(api4("entrypoint: !load missing.sh"), "unsupported", ["services", "s", "entrypoint"]),
    ],
  },
  ...["tty", "stdin_open"].map(
    (key): DispositionEntry => ({
      pattern: ["services", "*", key],
      disposition: "unsupported",
      owner: "lower-api4",
      golden: [diagnostic(api4(`${key}: true`), "unsupported", ["services", "s", key])],
    }),
  ),
  {
    pattern: ["services", "*", "packages"],
    disposition: "drop",
    owner: "lower-api4",
    golden: [diagnostic(api4("packages: {git: true}"), "dropped", ["services", "s", "packages", "git"])],
  },
  ...["tag", "buildx", "buildkit", "context", "groups", "steps"].map(
    (key): DispositionEntry => ({
      pattern: ["services", "*", "image", key],
      disposition: "drop",
      owner: "lower-api4",
      golden: [
        diagnostic(
          service(
            `api: 4, image: {imagefile: 'FROM nginx', ${key}: ${["context", "groups", "steps"].includes(key) ? "[local]" : "true"}}`,
          ),
          "dropped",
          ["services", "s", "image", key, ...(["context", "groups", "steps"].includes(key) ? [0] : [])],
        ),
      ],
    }),
  ),
  {
    pattern: ["services", "*", "image", "ssh"],
    disposition: "unsupported",
    owner: "lower-api4",
    golden: [
      diagnostic(service("api: 4, image: {imagefile: 'FROM nginx', ssh: true}"), "unsupported", [
        "services",
        "s",
        "image",
        "ssh",
      ]),
    ],
  },
  ...["imagefile", "args"].map(
    (key): DispositionEntry => ({
      pattern: ["services", "*", "image", key],
      disposition: "target",
      owner: "lower-api4",
      golden: [
        output(
          service("api: 4, image: {imagefile: 'FROM nginx', args: {VERSION: bookworm}}"),
          ["services", "s", "build", key === "args" ? "args" : "dockerfileInline"],
          key === "args" ? { VERSION: "bookworm" } : "FROM nginx",
        ),
      ],
    }),
  ),
  {
    pattern: ["services", "*", "healthcheck", "user"],
    disposition: "drop",
    owner: "lower-api4",
    golden: [
      diagnostic(api4("healthcheck: {command: echo ok, user: root}"), "dropped", [
        "services",
        "s",
        "healthcheck",
        "user",
      ]),
    ],
  },
  {
    pattern: ["services", "leet", "image", "context", "7"],
    disposition: "unsupported",
    owner: "lower-api4",
    golden: [
      diagnostic(
        service(
          "api: 4, image: {imagefile: 'FROM nginx', context: [a, b, c, d, e, f, g, {source: 'https://example.test/remote', dest: /remote}]}",
          "leet",
        ),
        "unsupported",
        ["services", "leet", "image", "context", 7],
      ),
    ],
  },
  ...["2", "5"].map(
    (index): DispositionEntry => ({
      pattern: ["services", "web4", "mounts", index],
      disposition: "drop",
      owner: "lower-api4",
      golden: [
        diagnostic(
          api4(
            `mounts: [${"'./src:/dst', ".repeat(Number(index))}{target: /file, contents: literal}]`,
            "web4",
          ),
          "dropped",
          ["services", "web4", "mounts", Number(index)],
        ),
      ],
    }),
  ),
  ...["3", "4"].map(
    (index): DispositionEntry => ({
      pattern: ["services", "web4", "mounts", index, "type"],
      disposition: "drop",
      owner: "lower-api4",
      golden: [
        diagnostic(
          api4(
            `mounts: [${"'./src:/dst', ".repeat(Number(index))}{source: ./src, target: /dst, type: copy}]`,
            "web4",
          ),
          "dropped",
          ["services", "web4", "mounts", Number(index), "type"],
        ),
      ],
    }),
  ),
  {
    pattern: ["services", "web4", "storage", "6"],
    disposition: "drop",
    owner: "lower-api4",
    golden: [
      diagnostic(
        api4("storage: [/a, /b, /c, /d, /e, /f, {destination: /data, type: image, owner: mysql}]", "web4"),
        "dropped",
        ["services", "web4", "storage", 6],
      ),
    ],
  },
  {
    pattern: ["services", "web4", "security", "ca", "1"],
    disposition: "unsupported",
    owner: "lower-api4",
    golden: [
      diagnostic(api4("security: {ca: [ca.crt, !load missing.crt]}", "web4"), "unsupported", [
        "services",
        "web4",
        "security",
        "ca",
        1,
      ]),
    ],
  },
  {
    pattern: ["proxy"],
    disposition: "target",
    owner: "lower-proxy",
    golden: [
      diagnostic("proxy: {s: [example.test]}\n", "rewritten", ["proxy", "s", 0]),
      output("proxy: OFF\n", ["router", "enabled"], false),
      diagnostic("proxy: ON\n", "dropped", ["proxy"]),
    ],
  },
  {
    pattern: ["proxy", "*", "*", "middlewares"],
    disposition: "target",
    owner: "lower-proxy",
    golden: [
      output(
        "proxy: {s: [{hostname: example.test, middlewares: [{name: test, key: headers.customrequestheaders.X-Test, value: yes}]}]}\n",
        ["proxy", "s", "0", "filters"],
        [{ type: "requestHeader", name: "test", header: "X-Test", value: "yes" }],
      ),
    ],
  },
  {
    pattern: ["events"],
    disposition: "target",
    owner: "lower-events",
    golden: [
      output(
        "events: {post-start: [echo ok]}\n",
        ["events", "post-start"],
        [{ cmd: "echo ok", service: "appserver" }],
      ),
    ],
  },
  {
    pattern: ["events", "pre-pull"],
    disposition: "drop",
    owner: "lower-events",
    golden: [diagnostic("events: {pre-pull: [echo ok]}\n", "dropped", ["events", "pre-pull"])],
  },
  {
    pattern: ["events", "post-start", "1", "node"],
    disposition: "target",
    owner: "legacy-tags",
    golden: [
      diagnostic("events: {post-start: [echo ok, {node: !import missing.sh}]}\n", "rewritten", [
        "events",
        "post-start",
        1,
        "node",
      ]),
    ],
  },
  {
    pattern: ["tooling"],
    disposition: "target",
    owner: "lower-tooling",
    golden: [output(tooling("service: s"), ["tooling", "task", "cmd"], "echo ok")],
  },
  ...["level", "usage", "examples"].map(
    (key): DispositionEntry => ({
      pattern: ["tooling", "*", key],
      disposition: "drop",
      owner: "lower-tooling",
      golden: [diagnostic(tooling(`${key}: old`), "dropped", ["tooling", "task", key])],
    }),
  ),
  {
    pattern: ["tooling", "*", "options"],
    disposition: "target",
    owner: "lower-tooling-input",
    golden: [
      output(
        tooling("options: {verbose: {boolean: true, alias: [v], describe: Verbose}}"),
        ["tooling", "task", "flags", "verbose"],
        { boolean: true, alias: "v", description: "Verbose" },
      ),
    ],
  },
  {
    pattern: ["tooling", "*", "options", "*", "interactive"],
    disposition: "drop",
    owner: "lower-tooling-input",
    golden: [
      diagnostic(tooling("options: {word: {interactive: {type: input}}}"), "dropped", [
        "tooling",
        "task",
        "options",
        "word",
        "interactive",
      ]),
    ],
  },
  {
    pattern: ["tooling", "*", "positionals"],
    disposition: "target",
    owner: "lower-tooling-input",
    golden: [
      output(
        tooling("positionals: {word: {type: string, describe: Word, choices: [bird]}}"),
        ["tooling", "task", "args", "word"],
        { order: 0, description: "Word", choices: ["bird"] },
      ),
    ],
  },
  {
    pattern: ["tooling", "word-imported", "cmd"],
    disposition: "target",
    owner: "legacy-tags",
    golden: [
      diagnostic("tooling: {word-imported: {cmd: !import missing.sh}}\n", "rewritten", [
        "tooling",
        "word-imported",
        "cmd",
      ]),
    ],
  },
  ...referenceVariants.map((variant): DispositionEntry => {
    const reference = variant === "cli:lando <other>" ? "lando custom-command" : variant.slice(4);
    const kind = /^lando (pull|push|share)$/.test(reference) ? "unsupported" : "needs-review";
    const command = variant.startsWith("env:") ? `echo ${reference}` : reference;
    return {
      pattern: [variant],
      disposition: kind === "unsupported" ? "unsupported" : "drop",
      owner: "legacy-references",
      golden: [
        diagnostic(`tooling: {task: {cmd: ${JSON.stringify(command)}}}\n`, kind, ["tooling", "task", "cmd"]),
        diagnostic(`events: {post-start: [${JSON.stringify(command)}]}\n`, kind, ["events", "post-start", 0]),
        diagnostic(service(`type: node:22, build: [${JSON.stringify(command)}]`), kind, [
          "services",
          "s",
          "build",
          0,
        ]),
        diagnostic(service(`type: node:22, environment: {REFERENCE: ${JSON.stringify(command)}}`), kind, [
          "services",
          "s",
          "environment",
          "REFERENCE",
        ]),
      ],
    };
  }),
];
