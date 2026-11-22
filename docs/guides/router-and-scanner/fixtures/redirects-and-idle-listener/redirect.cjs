const { createServer } = require("node:http");

createServer((request, response) => {
  const location = request.url?.startsWith("/external") ? "https://production.example/admin/" : "/admin/";
  response.writeHead(302, { Location: location }).end();
}).listen(Number(process.env.PORT), "0.0.0.0");
