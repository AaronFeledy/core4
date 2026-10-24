import { expect, test } from "bun:test";
import { BindAddress, PortablePath, type PublicationObservation } from "@lando/sdk/schema";
import { publishedEndpointUrl } from "../../src/operations/authority-url.ts";
import { projectServiceConnections } from "../../src/operations/service-connections.ts";
import { web } from "./start-progress-topology-support.ts";

test.each([
  { status: "unknown" },
  { status: "present", bindings: [] },
  { status: "present", bindings: [{ port: 15432, transport: "tcp", bindAddress: "::1", hostPort: 49152 }] },
] satisfies PublicationObservation[])(
  "retains planned listeners independently of $status publication evidence",
  (publications) => {
    const service = {
      ...web,
      endpoints: [
        { _tag: "internal", protocol: "tcp", port: 15432 },
        {
          _tag: "published",
          protocol: "tcp",
          port: 15432,
          publication: { bindAddress: BindAddress.make("::1") },
        },
        { _tag: "internal", protocol: "udp", port: 15432 },
        { _tag: "internal", protocol: "unix", socketPath: PortablePath.make("/run/db.sock") },
      ],
    } satisfies typeof web;
    const rows = projectServiceConnections({ service, state: "running", publications, routes: [] });
    expect(rows.filter((row) => row.scope === "app").map((row) => row.url)).toEqual([
      "tcp://web:15432",
      "udp://web:15432",
    ]);
    const host = rows.find((row) => row.scope === "host");
    expect(host?.binding).toBe(
      publications.status === "present" && publications.bindings.length > 0 ? "assigned" : "pending",
    );
  },
);

test.each(["::1"])("brackets %s once in scalar configured URL formatting", (address) => {
  const url = publishedEndpointUrl({
    _tag: "published",
    protocol: "http",
    port: 8080,
    publication: { bindAddress: BindAddress.make(address), hostPort: 49152 },
  });
  expect(url).toBe("http://[::1]:49152");
});
