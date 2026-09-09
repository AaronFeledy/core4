export const NODE_POSTGRES_PACKAGE_JSON_TEMPLATE = `${JSON.stringify(
  { name: "{{ app.name }}", scripts: { start: "node server.js" } },
  null,
  2,
)}\n`;

export const NODE_POSTGRES_SERVER_JS = `"use strict";
const http = require("http");

const server = http.createServer(function (_req, res) {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Hello from Lando\\n");
});

const port = Number(process.env.PORT || 3000);
server.listen(port, function () {
  console.log("Listening on port " + port);
});
`;
