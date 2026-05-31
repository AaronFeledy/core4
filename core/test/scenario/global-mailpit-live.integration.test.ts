import { type Socket, createConnection } from "node:net";
import { DateTime, Effect } from "effect";

import { bringDown, bringUp, makePodmanApiClient } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

import {
  MAILPIT_IMAGE,
  MAILPIT_SMTP_PORT,
  MAILPIT_WEB_PORT,
} from "../../../plugins/service-lando/src/mailpit-constants.ts";

const providerId = ProviderId.make("lando");
const SUBJECT = "US-115 Mailpit live integration";
const RECIPIENT = "recipient@example.lndo.site";

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-30T00:00:00Z"),
  source: "global-mailpit-live.integration.test",
  runtime: 4 as const,
};

const appPlan = (slug: string, service: ServicePlan): AppPlan => ({
  id: AppId.make(slug),
  name: slug,
  slug,
  root: AbsolutePath.make(`/tmp/lando-${slug}`),
  provider: providerId,
  services: { [service.name]: service },
  routes: [],
  networks: [],
  stores: [],
  metadata,
  extensions: {},
});

const mailpitService = (): ServicePlan => ({
  name: ServiceName.make("mailpit"),
  type: "compose",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: MAILPIT_IMAGE },
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [
    { port: MAILPIT_SMTP_PORT, protocol: "tcp", name: "smtp" },
    { port: MAILPIT_WEB_PORT, protocol: "http", name: "web" },
  ],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const waitForSmtpLine = (socket: Socket, expected: string): Promise<string> =>
  new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(
      () => reject(new Error(`SMTP response timed out waiting for ${expected}`)),
      10_000,
    );
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes(expected)) {
        clearTimeout(timeout);
        socket.off("data", onData);
        resolve(buffer);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });

const sendCommand = async (socket: Socket, command: string, expected: string): Promise<void> => {
  socket.write(`${command}\r\n`);
  await waitForSmtpLine(socket, expected);
};

const sendMail = async (): Promise<void> => {
  const socket = createConnection({ host: "127.0.0.1", port: MAILPIT_SMTP_PORT });
  try {
    await waitForSmtpLine(socket, "220");
    await sendCommand(socket, "HELO lando.test", "250");
    await sendCommand(socket, "MAIL FROM:<sender@example.lndo.site>", "250");
    await sendCommand(socket, `RCPT TO:<${RECIPIENT}>`, "250");
    await sendCommand(socket, "DATA", "354");
    socket.write(
      [
        `Subject: ${SUBJECT}`,
        `To: ${RECIPIENT}`,
        "From: sender@example.lndo.site",
        "",
        "Mailpit works.",
        ".",
      ].join("\r\n"),
    );
    socket.write("\r\n");
    await waitForSmtpLine(socket, "250");
    await sendCommand(socket, "QUIT", "221");
  } finally {
    socket.end();
  }
};

const fetchMailpitMessages = async (timeoutMs: number): Promise<unknown> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${MAILPIT_WEB_PORT}/api/v1/messages`);
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Mailpit API did not return messages within ${timeoutMs}ms: ${String(lastError)}`);
};

const messageMatches = (body: unknown): boolean => {
  const items = typeof body === "object" && body !== null && "messages" in body ? body.messages : undefined;
  if (!Array.isArray(items)) return false;
  return items.some((item) => {
    if (typeof item !== "object" || item === null) return false;
    const subject = "Subject" in item ? item.Subject : undefined;
    const to = "To" in item ? item.To : undefined;
    return String(subject).includes(SUBJECT) && JSON.stringify(to).includes(RECIPIENT);
  });
};

const waitForCapturedMessage = async (timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastBody: unknown;
  while (Date.now() < deadline) {
    lastBody = await fetchMailpitMessages(10_000);
    if (messageMatches(lastBody)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Mailpit did not capture expected message: ${JSON.stringify(lastBody)}`);
};

describe("global Mailpit capture — live integration", () => {
  test.skipIf(!process.env.LANDO_TEST_PODMAN_SOCKET)(
    "captures SMTP mail and exposes it through the Mailpit API",
    async () => {
      const socketPath = process.env.LANDO_TEST_PODMAN_SOCKET ?? "";
      expect(socketPath).toBeTruthy();

      const api = makePodmanApiClient(socketPath);
      const globalPlan = appPlan("global", mailpitService());

      try {
        const mailpitApplied = await Effect.runPromise(bringUp(globalPlan, { podmanApi: api }));
        expect(mailpitApplied.changed).toBe(true);

        await fetchMailpitMessages(120_000);
        await sendMail();
        await waitForCapturedMessage(120_000);
      } finally {
        await Effect.runPromise(Effect.either(bringDown(globalPlan, { podmanApi: api })));
      }
    },
    240_000,
  );
});
