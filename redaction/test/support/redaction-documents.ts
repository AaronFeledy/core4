/**
 * Seeded document generators for the redaction round-trip test.
 *
 * Documents are built with real serializers where one exists (JSON.stringify,
 * Bun.YAML.stringify, URLSearchParams) and with helpers that mirror the shell
 * and Python spellings. Every canary is deterministic: the same family and seed
 * always produce the same bytes.
 */

export type Family =
  | "shell-env"
  | "json"
  | "yaml"
  | "python-dict"
  | "query-string"
  | "bearer"
  | "multiline-quoted"
  | "crlf-shell";

export const FAMILIES: readonly Family[] = [
  "shell-env",
  "json",
  "yaml",
  "python-dict",
  "query-string",
  "bearer",
  "multiline-quoted",
  "crlf-shell",
];
export const SEEDS = 8;

export interface GeneratedDocument {
  readonly family: Family;
  readonly seed: number;
  readonly lineEnding: "lf" | "crlf";
  readonly text: string;
  /** Values that must not survive any redaction path. */
  readonly secrets: readonly string[];
  /** Values that must survive complete-text redaction unchanged. */
  readonly publics: readonly string[];
  /** Values the redactor is told about; the rest must be caught by a grammar. */
  readonly substringValues: readonly string[];
  readonly wholeTokenValues: readonly string[];
}

const secretCanary = (family: Family, seed: number, slot: number): string =>
  `sEcR3t-${family}-${seed}-${slot}-canary`;
const publicCanary = (family: Family, seed: number, slot: number): string =>
  `pUbL1c-${family}-${seed}-${slot}-canary`;

/** Mulberry32: deterministic chunk sizes and clock advances. */
export const makeRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

export const randomInt = (random: () => number, max: number): number => Math.floor(random() * (max + 1));

/**
 * A realistic shell quote helper: bare when the value is a simple word,
 * otherwise single or double quotes with their own escaping rules.
 */
const shellQuote = (value: string, style: "bare" | "single" | "double"): string => {
  switch (style) {
    case "bare":
      return value;
    case "single":
      return `'${value.replaceAll("'", `'\\''`)}'`;
    case "double":
      return `"${value.replaceAll(/["\\$`]/gu, (match) => `\\${match}`)}"`;
  }
};

/** Real serializer output for the Python dict repr spelling. */
const pythonRepr = (value: string): string => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

export const buildDocument = (family: Family, seed: number, lineEnding: "lf" | "crlf"): GeneratedDocument => {
  const patternSecret = (slot: number): string => secretCanary(family, seed, slot);
  const registeredSecret = (slot: number): string => secretCanary(family, seed, slot + 100);
  const publicValue = (slot: number): string => publicCanary(family, seed, slot);
  const secrets: string[] = [];
  const publics: string[] = [];
  const substringValues: string[] = [];
  const wholeTokenValues: string[] = [];
  const pattern = (slot: number): string => {
    const value = patternSecret(slot);
    secrets.push(value);
    return value;
  };
  const registered = (slot: number, wholeToken = false): string => {
    const value = registeredSecret(slot);
    secrets.push(value);
    if (wholeToken) wholeTokenValues.push(value);
    else substringValues.push(value);
    return value;
  };
  const publicText = (slot: number): string => {
    const value = publicValue(slot);
    publics.push(value);
    return value;
  };

  let text: string;
  switch (family) {
    case "shell-env": {
      text = [
        `export DB_PASSWORD=${shellQuote(pattern(0), "double")}`,
        `APP_TOKEN=${shellQuote(pattern(1), "bare")}`,
        `API_KEY = ${shellQuote(pattern(2), "single")}`,
        `AUTH_SECRET = ${shellQuote(pattern(3), "double")}`,
        `K=${shellQuote(registered(0, true), "bare")}`,
        `PAYLOAD = ${shellQuote(registered(1, true), "double")}`,
        `APP_ENV=${shellQuote(publicText(0), "bare")}`,
        `export SITE_NAME=${shellQuote(publicText(1), "double")}`,
      ].join("\n");
      break;
    }
    case "json": {
      const database = {
        host: "db",
        password: pattern(0),
        labels: { site: publicText(0) },
      };
      const document = {
        app: "bench",
        database,
        api_token: pattern(1),
        public_name: publicText(1),
        // Escaped JSON inside a string: the inner member grammar still applies.
        embedded: JSON.stringify({ secret: pattern(2), site: publicText(2) }),
        config: registered(0),
      };
      text = JSON.stringify(document, null, 2);
      break;
    }
    case "yaml": {
      const document = {
        database: {
          password: pattern(0),
          host: "db",
          public_name: publicText(0),
        },
        api_token: pattern(1),
        site_name: publicText(1),
        config: registered(0),
      };
      // Bun's block style is what Lando's own YAML output looks like.
      text = Bun.YAML.stringify(document, null, 2);
      break;
    }
    case "python-dict": {
      text = [
        `config = {'database': {'password': ${pythonRepr(pattern(0))}, 'host': 'db', 'site_name': ${pythonRepr(publicText(0))}},`,
        `  'api_token': ${pythonRepr(pattern(1))}, 'public_name': ${pythonRepr(publicText(1))},`,
        `  'payload': ${pythonRepr(registered(0, true))}}`,
      ].join("\n");
      break;
    }
    case "query-string": {
      const params = new URLSearchParams({
        access_token: pattern(0),
        page: "2",
        api_key: pattern(1),
        signature: pattern(2),
        site: publicText(0),
      });
      text = [
        `https://api.example.test/v1/items?${params.toString()}`,
        `GET /v2/items?page=3&token=${pattern(3)}&site=${publicText(1)} HTTP/1.1`,
      ].join("\n");
      break;
    }
    case "bearer": {
      text = [
        `Authorization: Bearer ${pattern(0)}`,
        `curl -H ${shellQuote(`Authorization: Bearer ${pattern(1)}`, "double")} https://api.example.test`,
        `X-Request-Id: ${publicText(0)}`,
        `-H ${shellQuote(`X-Client: ${publicText(1)}`, "single")}`,
      ].join("\n");
      break;
    }
    case "multiline-quoted": {
      text = [
        `service log: password="${pattern(0)}`,
        `  ${pattern(1)}" release complete`,
        `db pool: API_TOKEN="${pattern(2)}`,
        `  ${pattern(3)}"`,
        `site: ${publicText(0)}`,
      ].join("\n");
      break;
    }
    case "crlf-shell": {
      text = [
        `DB_PASSWORD="${pattern(0)}`,
        `  ${pattern(1)}"`,
        `ACCESS_TOKEN=${pattern(2)}`,
        `K=${registered(0, true)}`,
        `PUBLIC_NAME=${publicText(0)}`,
        `DB_PASSWORD_MULTI = "left-${pattern(3)}`,
        `right-${pattern(4)}"`,
      ].join("\n");
      break;
    }
  }

  return {
    family,
    seed,
    lineEnding,
    text: lineEnding === "crlf" ? text.replaceAll("\n", "\r\n") : text,
    secrets,
    publics,
    substringValues,
    wholeTokenValues,
  };
};
