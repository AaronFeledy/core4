/**
 * Deterministic corpus for the redaction benchmark.
 *
 * The corpus is a realistic mixed log: structured JSON, web access and error
 * lines, database startup, package installs, shell environment, YAML, PHP and
 * Node output, and Lando diagnostics. It is generated from one seed so every
 * checkout measures identical bytes, and it carries 100 substring and 100
 * whole-token registered values, two of them multi-line.
 */
// ==== deterministic corpus ====

/** Mulberry32: tiny, deterministic, and good enough to shuffle corpus shapes. */
const makeRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

export const CORPUS_LINE_COUNT = 10_000;
const SUBSTRING_VALUE_COUNT = 100;
const WHOLE_TOKEN_VALUE_COUNT = 100;

const substringValue = (index: number): string => `sEcR3t-sub-${index.toString().padStart(3, "0")}-canary`;
const wholeTokenValue = (index: number): string => `sEcR3t-whole-${index.toString().padStart(3, "0")}-canary`;
export const patternValue = (index: number): string =>
  `sEcR3t-pat-${index.toString().padStart(3, "0")}-canary`;
const multilineValue = (index: number): string =>
  `sEcR3t-multi-${index.toString().padStart(3, "0")}-left\nsEcR3t-multi-${index.toString().padStart(3, "0")}-right`;

export interface Corpus {
  readonly lines: readonly string[];
  readonly text: string;
  readonly values: readonly string[];
  readonly wholeTokenValues: readonly string[];
}

/**
 * A realistic mixed log: structured JSON, web access and error lines, database
 * startup, package installs, shell environment, YAML, PHP and Node output, and
 * Lando diagnostics. Secret-bearing lines exercise every canonical grammar;
 * public lines carry no canaries. Registered values appear only in prose so the
 * value layer, not a grammar, is what must mask them.
 */
export const buildCorpus = (): Corpus => {
  const random = makeRandom(20_260_409);
  // Two registered values contain a newline so the value layer, framing, and the
  // live hold all see a value that spans lines.
  const multiline = [multilineValue(0), multilineValue(1)];
  const values = [
    ...Array.from({ length: SUBSTRING_VALUE_COUNT - multiline.length }, (_, index) => substringValue(index)),
    ...multiline,
  ];
  const wholeTokenValues = Array.from({ length: WHOLE_TOKEN_VALUE_COUNT }, (_, index) =>
    wholeTokenValue(index),
  );
  const lines: string[] = [];
  const push = (line: string): void => {
    lines.push(line);
  };

  let wholeIndex = 0;
  let substringIndex = 0;
  for (let index = 0; lines.length < CORPUS_LINE_COUNT; index += 1) {
    if (index > 0 && index % 97 === 0 && substringIndex < values.length) {
      const value = values[substringIndex] ?? "";
      for (const line of `detail: observed ${value} during sync`.split("\n")) push(line);
      substringIndex += 1;
      continue;
    }
    if (index > 0 && index % 89 === 0 && wholeIndex < wholeTokenValues.length) {
      push(`trace note: value ${wholeTokenValues[wholeIndex] ?? ""} accepted`);
      wholeIndex += 1;
      continue;
    }

    const family = index % 12;
    const pick = <T>(entries: readonly T[]): T => entries[Math.floor(random() * entries.length)] as T;
    switch (family) {
      case 0:
        push(
          JSON.stringify({
            time: `2026-04-09T12:${String(index % 60).padStart(2, "0")}:00.000Z`,
            level: pick(["info", "warn", "error", "debug"]),
            service: pick(["appserver", "database", "cache", "edge"]),
            message: pick([
              "request completed",
              "connection pool saturated",
              "cache miss",
              "listener started",
            ]),
            requestId: `req-${index.toString(16).padStart(8, "0")}`,
            durationMs: (index * 7) % 900,
          }),
        );
        break;
      case 1:
        push(
          `10.0.0.${index % 250} - - [09/Apr/2026:12:00:${String(index % 60).padStart(2, "0")} +0000] "GET /api/v${index % 3}/items?page=${index % 20} HTTP/1.1" ${pick([200, 201, 304, 404, 500])} ${(index * 13) % 4096}`,
        );
        break;
      case 2:
        push(
          pick([
            "2026-04-09 12:00:00 0 [Note] InnoDB: Buffer pool(s) load completed",
            "2026-04-09 12:00:01 0 [Warning] Aborted connection 42 to db: 'lando' user: 'lando'",
            "[Note] mysqld: ready for connections. Version: '10.11.6-MariaDB' socket: '/run/mysqld/mysqld.sock'",
            "ERROR 1045 (28000): Access denied for user 'lando'@'localhost' (using password: YES)",
          ]),
        );
        break;
      case 3:
        push(
          pick([
            "added 1234 packages in 12s",
            "bun install v1.4.3 (abc123)",
            "Resolving dependencies",
            "Saved lockfile",
            "npm WARN deprecated inflight@1.0.6: This module is not supported",
          ]),
        );
        break;
      case 4:
        push(
          index % 10 === 0
            ? `export DB_PASSWORD="${patternValue(index % 20)}"`
            : `export APP_ENV=${pick(["local", "development", "review"])}`,
        );
        break;
      case 5:
        push(
          index % 10 === 1
            ? `  api_token: "${patternValue((index + 3) % 20)}"`
            : `  framework: ${pick(["drupal", "laravel", "wordpress"])}`,
        );
        break;
      case 6:
        push(
          pick([
            `    at Object.<anonymous> (/app/web/core/lib/Drupal.php:${index % 400}:15)`,
            `  #0 /app/vendor/autoload.php(${index % 200}): Composer\\Autoload\\ClassLoader->loadClass()`,
            "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
            'PHP Fatal error:  Uncaught Error: Class "Drupal" not found in /app/index.php:3',
          ]),
        );
        break;
      case 7:
        push(
          pick([
            "SecretNotFoundError: missing DB_PASSWORD",
            "secretRedaction: true",
            "Enter password:",
            "Lando could not reach the provider. Run `lando setup` and retry.",
            "WARN[0000] Found orphan containers ([app_cache_1]) for this project",
          ]),
        );
        break;
      case 8:
        push(
          pick([
            "[09-Apr-2026 12:00:00] NOTICE: fpm is running, pid 1",
            "[09-Apr-2026 12:00:00] WARNING: [pool www] server reached max_children setting (5)",
            '172.18.0.1 -  09/Apr/2026:12:00:00 +0000 "GET /index.php" 200',
          ]),
        );
        break;
      case 9:
        push(
          pick([
            "On branch main",
            "nothing to commit, working tree clean",
            "fatal: not a git repository (or any of the parent directories): .git",
            "HEAD is now at 2f52eaa Merge pull request #2400",
          ]),
        );
        break;
      case 10:
        push(
          `https://api.example.test/v1/items?${pick(["access_token", "api_key", "signature"])}=${patternValue((index + 7) % 20)}&page=${index % 5}`,
        );
        break;
      default:
        push(
          pick([
            `request ${index} finished in ${(index * 3) % 500}ms with status 200`,
            `worker ${index % 8} processed queue item ${index}`,
            `cache warmed for ${pick(["drupal", "laravel", "wordpress"])} in ${index % 90}ms`,
            `pulling image ${pick(["php:8.3-fpm", "mariadb:10.11", "nginx:1.27"])} layer ${index % 9}`,
          ]),
        );
        break;
    }
  }

  const trimmed = lines.slice(0, CORPUS_LINE_COUNT);
  return {
    lines: trimmed,
    text: trimmed.join("\n"),
    values,
    wholeTokenValues,
  };
};

// ==== shape variants ====

/**
 * Text shapes that separate the scanner's fast path from its grammar work:
 * a log with no trigger at all, one full of secret words that carry no value, a
 * realistic sparse-secret log, and adversarial runs that must stay linear.
 */
export interface BenchTexts {
  readonly triggerFree: string;
  readonly triggerHeavy: string;
  readonly sparseSecret: string;
  readonly adversarial: string;
}

const LINE_COUNT = 10_000;

export const buildTexts = (): BenchTexts => {
  const triggerFree = Array.from(
    { length: LINE_COUNT },
    (_, index) =>
      `2026-04-09T12:${String(index % 60).padStart(2, "0")}:00.000Z info worker ${index % 8} processed queue item ${index} in ${(index * 3) % 500}ms`,
  ).join("\n");

  const triggerHeavy = Array.from(
    { length: LINE_COUNT },
    (_, index) =>
      `2026-04-09T12:00:00.000Z info the password policy for token rotation and secret storage reported credential status ${index} with bearer marker and api_key hint`,
  ).join("\n");

  const sparseSecret = Array.from({ length: LINE_COUNT }, (_, index) => {
    if (index % 500 !== 0) return `2026-04-09T12:00:00.000Z info request ${index} completed with status 200`;
    const which = (index / 500) % 3;
    if (which === 0) return `export DB_PASSWORD="${patternValue((index / 500) % 20)}"`;
    if (which === 1) return `  api_token: "${patternValue(((index + 3) / 500) % 20)}"`;
    return `https://api.example.test/v1/items?access_token=${patternValue(((index + 7) / 500) % 20)}&page=1`;
  }).join("\n");

  const adversarial = [
    `${"token".repeat(20_000)}=x`,
    `${"\\".repeat(200_000)}"x`,
    `password:${" ".repeat(200_000)}x`,
    `https%3A%2F%2F${"x%3A".repeat(20_000)}`,
    `${"a.".repeat(60_000)}a://u:p`,
  ].join("\n");

  return { triggerFree, triggerHeavy, sparseSecret, adversarial };
};
