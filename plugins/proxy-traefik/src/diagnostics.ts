export const TRAEFIK_DIAGNOSTICS_ID = "traefik-diagnostics" as const;
export const TRAEFIK_DIAGNOSTICS_HOSTNAME = `${TRAEFIK_DIAGNOSTICS_ID}.global.internal` as const;
export const TRAEFIK_DIAGNOSTICS_PORT = 8080;
export const TRAEFIK_DIAGNOSTICS_SOURCE = "./proxy-traefik/diagnostic" as const;
export const TRAEFIK_DIAGNOSTICS_CONTAINER_DIR = "/etc/lando/diagnostics" as const;

// An Accept parameter value may be an RFC 9110 quoted-string, where commas,
// semicolons, and backslash-escaped quotes are literal text rather than list
// or parameter boundaries. Every step through a media range therefore consumes
// either one unquoted non-comma byte or one complete quoted-string.
const QUOTED_STRING = String.raw`"(?:[^"\\]|\\.)*"`;
const RANGE_UNIT = String.raw`(?:[^,"]|${QUOTED_STRING})`;
// Matches `$request_method:$http_accept` when some text/html range carries a
// positive weight: no `;q=0` (optionally `0.000`) terminates that range.
const HTML_ACCEPT_PATTERN = String.raw`^(?:GET|HEAD):(?:${RANGE_UNIT}+,)*\s*text/html(?=[\s;,]|$)(?!${RANGE_UNIT}*;\s*q\s*=\s*0(?:\.0*)?\s*(?:;|,|$))${RANGE_UNIT}*(?:,|$)`;

export const renderTraefikDiagnosticHtml = (): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>Route not found | Lando</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { box-sizing: border-box; min-height: 100dvh; margin: 0; padding: 2rem; display: grid; place-items: center; background: Canvas; color: CanvasText; }
      main { width: min(42rem, 100%); }
      p, li { line-height: 1.6; }
      .status { font: 700 0.875rem/1 ui-monospace, monospace; letter-spacing: 0.08em; text-transform: uppercase; }
      h1 { max-width: 18ch; margin: 1rem 0; font-size: clamp(2rem, 7vw, 4rem); line-height: 1; letter-spacing: -0.04em; }
      ol { margin: 2rem 0 0; padding-left: 1.5rem; }
      code { padding: 0.15rem 0.35rem; border: 1px solid ButtonBorder; border-radius: 0.25rem; font-family: ui-monospace, monospace; background: ButtonFace; color: ButtonText; }
    </style>
  </head>
  <body>
    <main>
      <p class="status">404 · Lando proxy</p>
      <h1>This address does not match a running Lando route.</h1>
      <p>The Lando proxy received the request, but no application route matched it.</p>
      <ol>
        <li>Start the application with <code>lando start</code>.</li>
        <li>Check its published addresses with <code>lando info</code>.</li>
        <li>Run <code>lando doctor</code> if the expected route is still unavailable.</li>
      </ol>
    </main>
  </body>
</html>
`;

export const renderTraefikDiagnosticNginxConfig = (): string =>
  [
    "worker_processes auto;",
    "pid /tmp/nginx.pid;",
    "error_log /dev/stderr notice;",
    "events { worker_connections 1024; }",
    "http {",
    "  access_log /dev/stdout;",
    "  include /etc/nginx/mime.types;",
    '  map "$request_method:$http_accept" $lando_error_uri {',
    "    default /_lando/404.txt;",
    `    "~*${HTML_ACCEPT_PATTERN.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" /_lando/404.html;`,
    "  }",
    "  server {",
    `    listen ${TRAEFIK_DIAGNOSTICS_PORT} default_server;`,
    "    server_name _;",
    "    charset utf-8;",
    "    error_page 404 =404 $lando_error_uri;",
    "    location / { return 404; }",
    "    location = /_lando/404.html {",
    "      internal;",
    `      alias ${TRAEFIK_DIAGNOSTICS_CONTAINER_DIR}/404.html;`,
    "    }",
    "    location = /_lando/404.txt {",
    "      internal;",
    '      default_type "text/plain; charset=utf-8";',
    '      return 404 "404 page not found\\n";',
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");

export const renderTraefikFallbackConfig = (): string =>
  [
    "http:",
    "  routers:",
    "    lando-fallback-http:",
    '      rule: "PathPrefix(`/`)"',
    "      entryPoints: [web]",
    "      priority: 1",
    `      service: ${TRAEFIK_DIAGNOSTICS_ID}`,
    "    lando-fallback-https:",
    '      rule: "PathPrefix(`/`)"',
    "      entryPoints: [websecure]",
    "      priority: 1",
    `      service: ${TRAEFIK_DIAGNOSTICS_ID}`,
    "      tls: {}",
    "  services:",
    `    ${TRAEFIK_DIAGNOSTICS_ID}:`,
    "      loadBalancer:",
    "        servers:",
    `          - url: http://${TRAEFIK_DIAGNOSTICS_HOSTNAME}:${TRAEFIK_DIAGNOSTICS_PORT}`,
    "",
  ].join("\n");
