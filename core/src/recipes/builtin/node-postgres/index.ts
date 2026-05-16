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
    "    command: node server.js",
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
        start: "node server.js",
      },
    },
    null,
    2,
  )}\n`;

export const serverJs = `import { createServer } from "http";

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Hello from Lando\n");
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => {
  console.log(\`Listening on http://localhost:\${port}\`);
});
`;
