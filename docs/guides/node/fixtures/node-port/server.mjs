import http from "node:http";

const port = Number.parseInt(process.env.PORT ?? "5173", 10);

http.createServer((_request, response) => response.end("Node authored port works\n")).listen(port);
