export const STATIC_INDEX = "static-index-ok\n";
export const STATIC_ASSET = "static-asset-ok\n";
export const HIDDEN_ASSET = "hidden\n";
export const PHP_INDEX = "app-index-ok\n";
export const PHP_ASSET = "php-static-asset-ok\n";

const phpResponse = (status: 403 | 404, marker: string, cookie: string, body: string | undefined): string =>
  [
    "<?php",
    `http_response_code(${status});`,
    `header('X-App-Marker: ${marker}');`,
    "header('Cache-Control: no-store');",
    `setcookie('appcookie', '${cookie}', ['path' => '/']);`,
    ...(body === undefined ? [] : [`echo ${JSON.stringify(body)};`]),
    "",
  ].join("\n");

/** Files written under a static app root; the document root is `dist/`. */
export const staticFixtureFiles: Readonly<Record<string, string>> = {
  "dist/index.html": STATIC_INDEX,
  "dist/asset.txt": STATIC_ASSET,
  "dist/noindex/hidden.txt": HIDDEN_ASSET,
};

/** Files written under a PHP app root; the app itself owns every `app*.php` status. */
export const phpFixtureFiles: Readonly<Record<string, string>> = {
  "index.php": `<?php\nheader('X-App-Marker: index');\necho ${JSON.stringify(PHP_INDEX)};\n`,
  "asset.txt": PHP_ASSET,
  "noindex/hidden.txt": HIDDEN_ASSET,
  "app403.php": phpResponse(403, "app403", "app403value", "app-403-body\n"),
  "app403-empty.php": phpResponse(403, "app403-empty", "app403emptyvalue", undefined),
  "app404.php": phpResponse(404, "app404", "app404value", "app-404-body\n"),
  "app404-empty.php": phpResponse(404, "app404-empty", "app404emptyvalue", undefined),
};

/** Response headers the app set itself and the server must pass through. */
export interface AppOwnedHeaders {
  readonly marker: string;
  readonly cookie?: string;
  readonly cacheControl?: string;
}

export interface ErrorPageCase {
  readonly name: string;
  readonly method: "GET" | "HEAD" | "POST";
  readonly path: string;
  readonly accept?: string;
  readonly status: number;
  /** `page` is the exact Lando server page; `exact` is the app-owned body. */
  readonly body: { readonly page: 403 | 404 } | { readonly exact: string };
  readonly headers?: AppOwnedHeaders;
}

const request = (
  name: string,
  path: string,
  status: number,
  body: ErrorPageCase["body"],
  extra: Partial<Pick<ErrorPageCase, "method" | "accept" | "headers">> = {},
): ErrorPageCase => ({ name, path, status, body, method: "GET", ...extra });

const appOwned = (
  name: string,
  path: string,
  status: 403 | 404,
  body: string,
  headers: AppOwnedHeaders,
  extra: Partial<Pick<ErrorPageCase, "method" | "accept">> = {},
): ErrorPageCase =>
  request(
    name,
    path,
    status,
    { exact: body },
    { headers: { ...headers, cacheControl: "no-store" }, ...extra },
  );

export const staticCases: ReadonlyArray<ErrorPageCase> = [
  request("serves the index", "/", 200, { exact: STATIC_INDEX }),
  request("serves a normal asset", "/asset.txt", 200, { exact: STATIC_ASSET }),
  request("serves an asset below a directory without an index", "/noindex/hidden.txt", 200, {
    exact: HIDDEN_ASSET,
  }),
  request("explains a missing file with the Lando 404 page", "/missing.html", 404, { page: 404 }),
  request("explains a missing nested path with the Lando 404 page", "/missing/deep/path", 404, { page: 404 }),
  request("explains a directory without an index with the Lando 403 page", "/noindex/", 403, { page: 403 }),
  request("keeps the error page location internal", "/_lando/errors/404.html", 404, { page: 404 }),
  request(
    "answers HEAD for a missing file without a body",
    "/missing.html",
    404,
    { page: 404 },
    { method: "HEAD" },
  ),
  request(
    "answers POST to a missing file with the Lando 404 page",
    "/missing.html",
    404,
    { page: 404 },
    {
      method: "POST",
    },
  ),
];

const app403 = { marker: "app403", cookie: "appcookie=app403value; path=/" };
const app403Empty = { marker: "app403-empty", cookie: "appcookie=app403emptyvalue; path=/" };
const app404 = { marker: "app404", cookie: "appcookie=app404value; path=/" };
const app404Empty = { marker: "app404-empty", cookie: "appcookie=app404emptyvalue; path=/" };

const phpCommonCases: ReadonlyArray<ErrorPageCase> = [
  request("serves the PHP index", "/", 200, { exact: PHP_INDEX }, { headers: { marker: "index" } }),
  request("serves a normal asset beside PHP", "/asset.txt", 200, { exact: PHP_ASSET }),
  request("explains a directory without an index with the Lando 403 page", "/noindex/", 403, { page: 403 }),
  appOwned("preserves an app 403 with a body", "/app403.php", 403, "app-403-body\n", app403),
  appOwned("preserves an app 403 with an empty body", "/app403-empty.php", 403, "", app403Empty),
  appOwned("preserves an app 404 with a body", "/app404.php", 404, "app-404-body\n", app404),
  appOwned("preserves an app 404 with an empty body", "/app404-empty.php", 404, "", app404Empty),
  appOwned("preserves an empty app 404 for HEAD", "/app404-empty.php", 404, "", app404Empty, {
    method: "HEAD",
  }),
  appOwned("preserves an empty app 404 for POST", "/app404-empty.php", 404, "", app404Empty, {
    method: "POST",
  }),
  appOwned("preserves an empty app 404 for a browser Accept", "/app404-empty.php", 404, "", app404Empty, {
    accept: "text/html",
  }),
];

export const nginxFpmCases: ReadonlyArray<ErrorPageCase> = [
  ...phpCommonCases,
  request("front-controls a missing path to index.php", "/missing.html", 200, { exact: PHP_INDEX }),
  request("preserves the FPM-owned missing script 404", "/missing.php", 404, { exact: "File not found.\n" }),
];

export const apacheCases: ReadonlyArray<ErrorPageCase> = [
  ...phpCommonCases,
  request("explains a missing file with the Lando 404 page", "/missing.html", 404, { page: 404 }),
  request("explains a missing script with the Lando 404 page", "/missing.php", 404, { page: 404 }),
  request(
    "answers HEAD for a missing file without a body",
    "/missing.html",
    404,
    { page: 404 },
    { method: "HEAD" },
  ),
];
