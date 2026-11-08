/** Match hidden segments in the server-decoded path, except the well-known segment. */
const HIDDEN_PATH_REGEX = String.raw`/\.(?!well-known(?:/|$))`;

export const nginxHiddenPathConfigLines = (): ReadonlyArray<string> => [
  `  location ~ ${HIDDEN_PATH_REGEX} {`,
  "    return 403;",
  "  }",
];

export const apacheHiddenPathDirectives = (): ReadonlyArray<string> => [
  `<LocationMatch "${HIDDEN_PATH_REGEX}">`,
  "Require all denied",
  "</LocationMatch>",
];
