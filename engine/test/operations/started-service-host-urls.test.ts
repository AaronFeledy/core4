import { expect, test } from "bun:test";
import { type ServiceState, StartedService } from "@lando/sdk/schema";
import { Schema } from "effect";
import { projectServiceConnections } from "../../src/operations/service-connections.ts";
import { web } from "./start-progress-topology-support.ts";

test.each(["stopped", "completed", "paused", "error"] satisfies ServiceState[])(
  "retains configured addresses as inactive when final state is %s",
  (state) => {
    const service = {
      ...web,
      endpoints: [{ _tag: "published", protocol: "http", port: 3000, publication: { hostPort: 8080 } }],
    } satisfies typeof web;
    const row = {
      name: String(web.name),
      state,
      connections: projectServiceConnections({
        service,
        state,
        publications: {
          status: "present",
          bindings: [{ port: 3000, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 8080 }],
        },
        routes: [],
      }),
    };
    expect(Schema.encodeSync(StartedService)(row)).toEqual(row);
    expect(row.connections.map((connection) => connection.state)).toEqual(["inactive", "inactive"]);
    expect(row.connections.map((connection) => connection.url)).toEqual([
      "http://web:3000",
      "http://localhost:8080",
    ]);
  },
);
