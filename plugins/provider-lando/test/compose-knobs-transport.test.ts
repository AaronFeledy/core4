import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

import { bringUp } from "../src/bring-up.ts";
import { makePodmanApiClient } from "../src/capabilities.ts";

interface CreateRequest {
  readonly url: string;
  readonly body: unknown;
}

interface IpcFixture {
  readonly endpoint: string;
  readonly createRequests: CreateRequest[];
}

const providerId = ProviderId.make("lando");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-07-27T00:00:00Z"),
  source: "provider-lando/compose-knobs-transport.test.ts",
  runtime: 4 as const,
};

const plan: AppPlan = {
  id: AppId.make("compose-knob-transport"),
  name: "Compose Knob Transport",
  slug: "compose-knob-transport",
  root: AbsolutePath.make("/tmp/lando-compose-knob-transport"),
  provider: providerId,
  services: {
    [serviceName]: {
      name: serviceName,
      type: "web",
      provider: providerId,
      primary: true,
      artifact: { kind: "ref", ref: "nginx:1.27-alpine" },
      environment: {},
      mounts: [],
      storage: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata,
      extensions: { compose: { privileged: true } },
    } satisfies ServicePlan,
  },
  routes: [],
  networks: [],
  networking: { perAppBridge: { name: "compose-knob-transport-network", driver: "bridge" } },
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const respond = (response: ServerResponse, status: number, body = ""): void => {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(body);
};

const withIpcServer = async <A>(action: (fixture: IpcFixture) => Promise<A>): Promise<A> => {
  const root = await mkdtemp(join(tmpdir(), "lando-compose-knobs-transport-"));
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\lando-compose-knobs-${process.pid}-${randomUUID()}`
      : join(root, "podman.sock");
  const createRequests: CreateRequest[] = [];
  let running = false;
  const server = createServer(async (request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.includes("/networks/")) {
      respond(response, 200, "{}");
      return;
    }
    if (request.method === "GET" && url.endsWith("/json")) {
      respond(response, running ? 200 : 404, running ? '{"State":{"Running":true}}' : "{}");
      return;
    }
    if (request.method === "POST" && url.startsWith("/v6.0.0/containers/create?")) {
      createRequests.push({ url, body: await readBody(request) });
      respond(response, 201, "{}");
      return;
    }
    if (request.method === "POST" && url.endsWith("/start")) {
      running = true;
      respond(response, 204);
      return;
    }
    respond(response, 500, JSON.stringify({ method: request.method, url }));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
    return await action({ endpoint, createRequests });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((cause) => (cause === undefined ? resolve() : reject(cause))),
    );
    await rm(root, { recursive: true, force: true });
  }
};

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

describe("provider-lando Compose knob transport", () => {
  test("Given a privileged service, when bringUp uses the platform IPC transport, then create carries Privileged", async () => {
    // Given
    await withIpcServer(async ({ endpoint, createRequests }) => {
      const client = makePodmanApiClient(endpoint);

      // When
      await Effect.runPromise(bringUp(plan, { podmanApi: client }));

      // Then
      expect(createRequests).toHaveLength(1);
      expect(createRequests[0]?.url).toBe("/v6.0.0/containers/create?name=lando-compose-knob-transport-web");
      expect(field(field(createRequests[0]?.body, "HostConfig"), "Privileged")).toBe(true);
    });
  });
});
