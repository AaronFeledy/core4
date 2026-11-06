import http from "node:http";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const server = http.createServer((_request, response) => response.end("Node init opt-out works\n"));
server.listen(port);

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
