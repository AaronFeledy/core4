import type { PromptAnswers } from "../prompts/runtime";

export const WEBROOT_PATTERN = /^\/[A-Za-z0-9._/-]*$/u;

export const PHP_VERSIONS = ["8.1", "8.2", "8.3", "8.4", "8.5"] as const;
export const COMPOSER_OPTIONS = ["2", "2.7.7", "false"] as const;
export const DRUPAL_COMPOSER_OPTIONS = ["2", "2.7.7"] as const;
export const DRUPAL_DATABASES = ["mariadb:11.4", "mariadb:10.11", "mysql:8.0", "postgres:16"] as const;
export const LAMP_DATABASES = ["mariadb:11.4", "mariadb:10.11", "mysql:8.0"] as const;

export type PhpStackDefaults = {
  readonly php: string;
  readonly database: string;
  readonly webroot: string;
  readonly composer: string;
};

export type ResolvedPhpStack = {
  readonly php: string;
  readonly database: string;
  readonly webroot: string;
  readonly composer: string | false;
  readonly webserver: "apache" | "nginx";
};

const yamlChoices = (values: ReadonlyArray<string>): string =>
  values.map((value) => `      - value: '${value}'`).join("\n");

export const phpPromptYaml = `  - name: php
    type: select
    message: PHP version
    default: '8.3'
    choices:
${yamlChoices(PHP_VERSIONS)}`;

export const composerPromptYaml = (
  values: ReadonlyArray<string> = COMPOSER_OPTIONS,
): string => `  - name: composer
    type: select
    message: Composer version
    default: '2'
    choices:
${yamlChoices(values)}`;

export const webrootPromptYaml = (fallback: string): string => `  - name: webroot
    type: text
    message: PHP webroot
    default: ${fallback}
    validate:
      pattern: ${WEBROOT_PATTERN.source}
      message: Webroot must be an absolute container path.`;

export const databasePromptYaml = (values: ReadonlyArray<string>): string => `  - name: database
    type: select
    message: Database
    default: '${values[0] ?? "mariadb:11.4"}'
    choices:
${yamlChoices(values)}`;

export const webserverPromptYaml = `  - name: webserver
    type: select
    message: Web server
    default: apache
    choices:
      - value: apache
      - value: nginx`;

const answerString = (
  answers: PromptAnswers | Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const value = answers[key];
  return typeof value === "string" ? value : undefined;
};

export const resolvePhpStackAnswers = (
  answers: PromptAnswers | Readonly<Record<string, unknown>>,
  defaults: PhpStackDefaults,
): ResolvedPhpStack => {
  const composerRaw = answerString(answers, "composer") ?? defaults.composer;
  return {
    php: answerString(answers, "php") ?? defaults.php,
    database: answerString(answers, "database") ?? defaults.database,
    webroot: answerString(answers, "webroot") ?? defaults.webroot,
    composer: composerRaw === "false" ? false : composerRaw,
    webserver: answerString(answers, "webserver") === "nginx" ? "nginx" : "apache",
  };
};

export type PhpAppserverLinesInput = {
  readonly php: string;
  readonly webroot: string;
  readonly composer: string | false;
  readonly webserver: "apache" | "nginx";
  readonly allowOverride?: boolean;
  readonly port?: number;
  readonly dependsOn: ReadonlyArray<string>;
  readonly framework?: string;
};

export const renderPhpAppserverLines = (input: PhpAppserverLinesInput): ReadonlyArray<string> => {
  const lines = ["  appserver:", `    type: php:${input.php}`];
  if (input.framework !== undefined) lines.push(`    framework: ${input.framework}`);
  if (input.webserver === "nginx") lines.push("    via: fpm");
  lines.push(`    webroot: ${input.webroot}`);
  lines.push(input.composer === false ? "    composer: false" : `    composer: "${input.composer}"`);
  if (input.webserver === "apache" && input.allowOverride === true) lines.push("    allowOverride: true");
  if (input.webserver === "apache" && input.port !== undefined) lines.push(`    port: ${String(input.port)}`);
  lines.push("    dependsOn:");
  for (const dependency of input.dependsOn) lines.push(`      - ${dependency}`);
  return lines;
};

export const renderDatabaseLines = (
  database: string,
  extra: { readonly databaseName?: string } = {},
): ReadonlyArray<string> => {
  const lines = ["  database:", `    type: ${database}`];
  if (extra.databaseName !== undefined) lines.push(`    database: ${extra.databaseName}`);
  return lines;
};

export const renderNginxEdgeLines = (webroot: string): ReadonlyArray<string> => [
  "  edge:",
  "    type: nginx",
  "    backend: appserver",
  `    webroot: ${webroot}`,
];

export const composerToolingLines = (): ReadonlyArray<string> => [
  "  composer:",
  "    service: appserver",
  "    description: Run Composer inside the appserver service.",
  "    cmds:",
  "      - composer",
];
