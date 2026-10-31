import { expect } from "bun:test";
import { Effect, Schema } from "effect";
import { type ListenerApp, listenerHttp, probeListener, publicationFor } from "./listener-cli.ts";

const mailList = Schema.fromJsonString(
  Schema.Struct({ messages: Schema.Array(Schema.Struct({ ID: Schema.String, Subject: Schema.String })) }),
);
const mailMessage = Schema.fromJsonString(
  Schema.Struct({
    Subject: Schema.String,
    Text: Schema.String,
    To: Schema.Array(Schema.Struct({ Address: Schema.String })),
  }),
);

export const mailpitJourney = Effect.fnUntraced(function* (app: ListenerApp, moved: boolean) {
  const smtp = moved ? 11025 : 1025;
  const http = moved ? 18025 : 8025;
  // Given: a typed mail service and a different container driving SMTP.
  const started = yield* app.start({
    services: {
      mail: {
        type: "mailpit",
        appMount: false,
        home: false,
        ...(process.env.LANDO_TEST_MAILPIT_IMAGE ? { image: process.env.LANDO_TEST_MAILPIT_IMAGE } : {}),
        ...(moved ? { port: smtp, environment: { MP_UI_BIND_ADDR: `0.0.0.0:${http}` } } : {}),
        ports: [`127.0.0.1::${smtp}`, `127.0.0.1::${http}`],
      },
      sender: {
        type: "compose",
        image: process.env.LANDO_TEST_LISTENER_CLIENT_IMAGE ?? "docker.io/library/alpine:3.21",
        command: ["sleep", "infinity"],
        appMount: false,
        home: false,
      },
    },
  });
  const info = yield* app.info();
  const service = info.services.find((item) => item.service === "mail");
  if (service === undefined) return yield* Effect.fail(new Error("info omitted mail"));
  const api = publicationFor(service.connections, http);
  publicationFor(service.connections, smtp);
  const listener = service.connections.find((item) => item.source === "listener" && item.port === smtp);
  if (listener === undefined) return yield* Effect.fail(new Error("info omitted SMTP listener"));
  expect(
    service.connections
      .filter((item) => item.source === "listener")
      .map((item) => item.port)
      .sort(),
  ).toEqual([smtp, http].sort());
  const initial = started.servicesStarted.find((item) => item.name === "mail");
  if (initial === undefined) return yield* Effect.fail(new Error("start omitted mail"));
  publicationFor(initial.connections, smtp);
  publicationFor(initial.connections, http);
  const messagesUrl = new URL("/api/v1/messages", api.url).href;
  yield* probeListener(
    listenerHttp(messagesUrl).pipe(
      Effect.flatMap((response) =>
        response.status === 200 ? Effect.void : Effect.fail(new Error(`Mailpit HTTP ${response.status}`)),
      ),
    ),
  );
  const unique = crypto.randomUUID();
  const subject = `listener-${unique}`;
  const recipient = `${unique}@example.test`;
  const text = `Exact SMTP body ${unique}`;
  const payload = [
    "HELO sender",
    "MAIL FROM:<sender@example.test>",
    `RCPT TO:<${recipient}>`,
    "DATA",
    `Subject: ${subject}`,
    `To: ${recipient}`,
    "From: sender@example.test",
    "",
    text,
    ".",
    "QUIT",
    "",
  ].join("\\r\\n");
  // When: the separate sender delivers one unique message over the projected app listener.
  yield* app.exec("sender", ["sh", "-c", `printf '%b' '${payload}' | nc -w 5 ${listener.host} ${smtp}`]);
  // Then: retrieve that exact message, not merely a live inbox or a matching substring.
  yield* probeListener(
    Effect.gen(function* () {
      const list = yield* listenerHttp(messagesUrl);
      const message = Schema.decodeUnknownSync(mailList)(list.body).messages.find(
        (item) => item.Subject === subject,
      );
      if (message === undefined) return yield* Effect.fail(new Error("Unique SMTP message has not arrived"));
      const response = yield* listenerHttp(
        new URL(`/api/v1/message/${encodeURIComponent(message.ID)}`, api.url).href,
      );
      expect(response.status).toBe(200);
      const captured = Schema.decodeUnknownSync(mailMessage)(response.body);
      expect(captured.Subject).toBe(subject);
      expect(captured.To.map((item) => item.Address)).toEqual([recipient]);
      expect(captured.Text.trimEnd()).toBe(text);
    }),
  );
});

export const minioJourney = Effect.fnUntraced(function* (app: ListenerApp, moved: boolean) {
  const apiPort = moved ? 9001 : 9000;
  const consolePort = moved ? 19001 : 9001;
  const image = process.env.LANDO_TEST_MINIO_IMAGE;
  if (image === undefined) return yield* Effect.fail(new Error("Explicit MinIO QA image is required"));
  // Given: only explicit BYO image intent, with built-in listener discovery retained.
  const started = yield* app.start({
    services: {
      objects: {
        type: "minio",
        image,
        appMount: false,
        home: false,
        ...(moved ? { port: apiPort, consolePort } : {}),
        environment: { MINIO_ROOT_USER: "listenerroot", MINIO_ROOT_PASSWORD: "listenerpassword123" },
        ports: [`127.0.0.1::${apiPort}`, `127.0.0.1::${consolePort}`],
      },
    },
  });
  const info = yield* app.info();
  const service = info.services.find((item) => item.service === "objects");
  if (service === undefined) return yield* Effect.fail(new Error("info omitted objects"));
  const api = publicationFor(service.connections, apiPort);
  const console = publicationFor(service.connections, consolePort);
  expect(
    service.connections
      .filter((item) => item.source === "listener")
      .map((item) => item.port)
      .sort(),
  ).toEqual([apiPort, consolePort].sort());
  const apiHealth = new URL(api.url);
  apiHealth.pathname = "/minio/health/live";
  const scans = started.checks?.filter((check) => check.kind === "http") ?? [];
  expect(scans.find((check) => check.url === apiHealth.href)).toMatchObject({
    verdict: "ready",
    statusCode: 200,
  });
  expect(scans.find((check) => check.url === new URL(console.url).href)).toMatchObject({
    verdict: "ready",
    statusCode: 200,
  });
  const health = yield* listenerHttp(apiHealth.href);
  expect(health.status).toBe(200);
  const root = yield* listenerHttp(api.url);
  expect(root.status).toBe(403);
  const ui = yield* listenerHttp(console.url);
  expect(ui.status).toBe(200);
  expect(ui.body.toLowerCase()).toContain("<html");
  const bucket = `proof-${crypto.randomUUID()}`;
  const bytes = Buffer.concat([Buffer.from([0, 1, 2, 255, 13, 10]), Buffer.from(crypto.randomUUID())]);
  const encoded = bytes.toString("base64");
  // When: mc writes and reads real non-text object bytes through the effective API port.
  const received = yield* app.exec("objects", [
    "sh",
    "-c",
    `mc mb local/${bucket} >/dev/null && printf '%s' '${encoded}' | base64 -d | mc pipe local/${bucket}/object >/dev/null && mc cat local/${bucket}/object | base64`,
  ]);
  // Then: byte identity proves useful S3 behavior beyond an HTTP readiness response.
  expect(Buffer.from(received.replace(/\s/gu, ""), "base64")).toEqual(bytes);
});
