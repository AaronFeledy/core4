export const MEAN_PACKAGE_JSON_TEMPLATE = `${JSON.stringify(
  {
    name: "{{ app.name }}",
    private: true,
    scripts: {
      start: "node server.js",
    },
    dependencies: {
      express: "^4.21.2",
    },
  },
  null,
  2,
)}\n`;

export const MEAN_SERVER_JS = `"use strict";
const express = require("express");

const app = express();
const port = Number(process.env.PORT || 3000);

app.get("/", function (_req, res) {
  res.type("text/plain").send("Hello from Lando\\n");
});

app.listen(port, function () {
  console.log("Listening on port " + port);
});
`;
