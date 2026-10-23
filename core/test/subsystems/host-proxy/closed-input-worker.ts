import { createServer } from "node:net";
import { defaultSpawnWorker } from "@lando/engine/subsystems/host-proxy/worker-process";
import { ownerOnlyFileAccess } from "../../_support/private-file-access.ts";

export const closedInputWorker = async (logsDir: string, exits: boolean) => {
  const connection = Promise.withResolvers<import("node:net").Socket>();
  const server = createServer((socket) => connection.resolve(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing control port");
  const worker = await defaultSpawnWorker({
    argv: [
      process.execPath,
      "-e",
      `
      const { closeSync } = require("node:fs");
      const { connect } = require("node:net");
      closeSync(0);
      const socket = connect(${address.port}, "127.0.0.1", () => {
        console.log(JSON.stringify({_tag:"ready",appId:"demo",sessionId:"test",token:"test",controlToken:"test",shimPath:"/test"}));
      });
      socket.on("data", () => { console.error("controlled worker crash"); process.exit(7); });
    `,
      "--app-id",
      "demo",
    ],
    logsDir,
    privateFileAccess: ownerOnlyFileAccess,
  });
  const socket = await connection.promise;
  await worker.readReady();
  return {
    ...worker,
    writeStdin: async (value: string) => {
      const delivery = worker.writeStdin(value);
      if (exits) socket.write("exit");
      await delivery;
    },
    terminate: async () => {
      await worker.terminate();
      socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
};
