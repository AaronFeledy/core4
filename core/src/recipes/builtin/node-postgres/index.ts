export const landofile = (name: string): string =>
  [
    `name: ${name}`,
    "runtime: 4",
    "services:",
    "  web:",
    "    type: node:lts",
    "    ports:",
    "      - 3000:3000",
    "    environment:",
    "      NODE_ENV: development",
    "    volumes:",
    "      - ./:/app",
    "    command: bun run server.js",
    "    dependsOn:",
    "      - database",
    "  database:",
    "    type: postgres",
    "",
  ].join("\n");

export const packageJson = (name: string): string =>
  `${JSON.stringify(
    {
      name,
      type: "module",
      scripts: {
        start: "bun run server.js",
      },
    },
    null,
    2,
  )}\n`;

export const serverJs =
  `const server = Bun.serve({
  port: process.env.PORT ?? 3000,
  fetch() {
    return new Response("Hello from Lando");
  },
});

console.log(` +
  "`Listening on ${server.url}`" +
  `);
`;
