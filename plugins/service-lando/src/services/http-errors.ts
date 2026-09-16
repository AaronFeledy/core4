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

export const landoErrorPageSetupLines = (): ReadonlyArray<string> => [
  `mkdir -p ${LANDO_ERROR_PAGE_DIR}`,
  `cat > ${LANDO_ERROR_PAGE_DIR}/403.html <<'LANDO_ERROR_403'`,
  landoErrorPage(403),
  "LANDO_ERROR_403",
  `cat > ${LANDO_ERROR_PAGE_DIR}/404.html <<'LANDO_ERROR_404'`,
  landoErrorPage(404),
  "LANDO_ERROR_404",
];

export const nginxErrorPageConfigLines = (): ReadonlyArray<string> => [
  "  error_page 403 /_lando/errors/403.html;",
  "  error_page 404 /_lando/errors/404.html;",
  "  location ^~ /_lando/errors/ {",
  "    internal;",
  `    alias ${LANDO_ERROR_PAGE_DIR}/;`,
  "  }",
];

export const apacheErrorPageConfigLines = (): ReadonlyArray<string> => [
  `  Alias "/_lando/errors/" "${LANDO_ERROR_PAGE_DIR}/"`,
  `  <Directory "${LANDO_ERROR_PAGE_DIR}">`,
  "    AllowOverride None",
  "    Require all granted",
  "  </Directory>",
  "  ErrorDocument 403 /_lando/errors/403.html",
  "  ErrorDocument 404 /_lando/errors/404.html",
];
