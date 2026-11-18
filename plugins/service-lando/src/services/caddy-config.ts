import { ServiceConfigIssue } from "./_feature-helpers.ts";
import { caddyErrorPageConfigLines } from "./http-errors.ts";
import { caddyHiddenPathConfigLines } from "./http-hidden-paths.ts";

/**
 * Where a generated `static:caddy` service reads its Caddyfile.
 *
 * The file is image content, baked by the same root build step that installs
 * the shared error pages, so the planned user writes nothing at start. The path
 * is not under a mounted app root and is read-only at runtime.
 */
export const CADDY_CONFIG_PATH = "/usr/share/lando/caddy/Caddyfile" as const;

const CADDY_UNQUOTABLE_PATH = /[\r\n\0]/u;

/**
 * Quote a value for a Caddyfile double-quoted token.
 *
 * Inside a quoted token Caddy only unescapes `\"`; every other backslash stays
 * literal and is later handled by the placeholder replacer. Escaping the
 * placeholder braces keeps an authored path from expanding placeholders, and a
 * backslash is rejected because a trailing one would escape the closing quote.
 */
export const caddyfileString = (value: string): string => {
  if (CADDY_UNQUOTABLE_PATH.test(value)) {
    throw new ServiceConfigIssue(
      ["webroot"],
      "Caddy paths cannot contain a line break or NUL byte.",
      "Use a single-line container path.",
    );
  }
  if (value.includes("\\")) {
    throw new ServiceConfigIssue(
      ["webroot"],
      "Caddy paths cannot contain a backslash.",
      "Use a POSIX container path with forward slashes.",
    );
  }
  return `"${value.replaceAll('"', '\\"').replaceAll("{", "\\{").replaceAll("}", "\\}")}"`;
};

const validatedPort = (port: number): number => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ServiceConfigIssue(
      ["port"],
      `Caddy port must be an integer from 1 to 65535 (got ${String(port)}).`,
      "Set port to a valid TCP port.",
    );
  }
  return port;
};

/**
 * The complete Caddyfile a Lando-owned `static:caddy` service runs.
 *
 * The site listens on plain HTTP only (`auto_https off`, `admin off`), so the
 * router or a published host port owns TLS. Hidden paths are answered with an
 * `error` rather than `respond` so the shared `handle_errors` page and its
 * original status apply. Only the segment exactly named `.well-known` is
 * exempt: the second matcher rejects any other hidden segment in a path that
 * also mentions `.well-known`. Caddy's own canonical redirects stay relative,
 * so the browser keeps the router's public scheme, host, and port.
 *
 * The emitted text uses tabs so `caddy run` does not warn that the baked
 * Caddyfile is unformatted.
 */
export const renderCaddyfile = (input: { readonly port: number; readonly docRoot: string }): string => {
  const port = validatedPort(input.port);
  return [
    "{",
    "\tadmin off",
    "\tauto_https off",
    "}",
    "",
    `http://:${String(port)} {`,
    `\troot * ${caddyfileString(input.docRoot)}`,
    ...caddyHiddenPathConfigLines(),
    ...caddyErrorPageConfigLines(),
    "\tfile_server",
    "}",
    "",
  ].join("\n");
};

/** The launcher a Lando-owned `static:caddy` service runs as PID 1. */
export const caddyLauncherCommand = (): ReadonlyArray<string> => [
  "caddy",
  "run",
  "--config",
  CADDY_CONFIG_PATH,
  "--adapter",
  "caddyfile",
];
