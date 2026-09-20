import { Buffer } from "node:buffer";

import type { ServiceBuildStepIntent } from "@lando/sdk/services";

export const LANDO_ERROR_PAGE_DIR = "/usr/share/lando/errors" as const;

export const landoErrorPage = (status: 403 | 404): string => {
  const title = status === 403 ? "Access denied" : "Page not found";
  const explanation =
    status === 403
      ? "The web server understood the request but could not serve this path. Check the document root, index file, and file permissions."
      : "The web server could not find this path. Check the application route and configured document root.";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>${String(status)} ${title} | Lando</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { box-sizing: border-box; min-height: 100dvh; margin: 0; padding: 2rem; display: grid; place-items: center; background: Canvas; color: CanvasText; }
      main { width: min(42rem, 100%); }
      p { max-width: 62ch; line-height: 1.6; }
      .status { font: 700 0.875rem/1 ui-monospace, monospace; letter-spacing: 0.08em; text-transform: uppercase; }
      h1 { max-width: 18ch; margin: 1rem 0; font-size: clamp(2rem, 7vw, 4rem); line-height: 1; letter-spacing: -0.04em; }
      code { padding: 0.15rem 0.35rem; border: 1px solid ButtonBorder; border-radius: 0.25rem; font-family: ui-monospace, monospace; background: ButtonFace; color: ButtonText; }
    </style>
  </head>
  <body>
    <main>
      <p class="status">${String(status)} · Lando web server</p>
      <h1>${title}</h1>
      <p>${explanation}</p>
      <p>Run <code>lando info</code> to review service addresses and <code>lando logs</code> to inspect the server response.</p>
    </main>
  </body>
</html>`;
};

export const LANDO_ERROR_PAGES_BUILD_STEP_ID = "service-lando.http-errors:pages" as const;

const LANDO_ERROR_PAGE_STATUSES = [403, 404] as const;

/** The exact bytes a server sends for a Lando-owned error page. */
export const landoErrorPageBytes = (status: 403 | 404): string => `${landoErrorPage(status)}\n`;

/**
 * The shared 403/404 pages every Lando-owned web server serves.
 *
 * The pages are image content, produced once during the image build as root,
 * rather than written by each launcher as PID 1. That is what lets a service
 * keep serving them under a non-root `user:`: a start command that writes
 * nothing needs no write permission anywhere.
 *
 * Each page travels base64-encoded because a derived build renders this step as
 * a Dockerfile `RUN`, and a build-step token carrying CR or LF is refused
 * there. Encoding keeps the served bytes identical to the page this module
 * defines without putting a newline in the command.
 */
export const landoErrorPagesBuildStep = (): ServiceBuildStepIntent => ({
  id: LANDO_ERROR_PAGES_BUILD_STEP_ID,
  phase: "build",
  user: "root",
  command: [
    "sh",
    "-c",
    [
      "set -eu",
      `mkdir -p ${LANDO_ERROR_PAGE_DIR}`,
      ...LANDO_ERROR_PAGE_STATUSES.map(
        (status) =>
          `printf '%s' '${Buffer.from(landoErrorPageBytes(status), "utf8").toString("base64")}' | base64 -d > ${LANDO_ERROR_PAGE_DIR}/${String(status)}.html`,
      ),
    ].join("; "),
  ],
});

export const nginxErrorPageConfigLines = (): ReadonlyArray<string> => [
  "  error_page 403 /_lando/errors/403.html;",
  "  error_page 404 /_lando/errors/404.html;",
  "  location ^~ /_lando/errors/ {",
  "    internal;",
  `    alias ${LANDO_ERROR_PAGE_DIR}/;`,
  "  }",
];

/** Apache directives, one per element, ready to hand to a launcher as `-c` arguments. */
export const apacheErrorPageDirectives = (): ReadonlyArray<string> => [
  `Alias "/_lando/errors/" "${LANDO_ERROR_PAGE_DIR}/"`,
  `<Directory "${LANDO_ERROR_PAGE_DIR}">`,
  "AllowOverride None",
  "Require all granted",
  "</Directory>",
  "ErrorDocument 403 /_lando/errors/403.html",
  "ErrorDocument 404 /_lando/errors/404.html",
];
