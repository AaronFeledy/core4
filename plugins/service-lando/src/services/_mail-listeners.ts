import { type EndpointPlan, PortNumber, type ServiceConfig } from "@lando/sdk/schema";
import { MAILPIT_SMTP_PORT, MAILPIT_WEB_PORT } from "../mailpit-constants.ts";
import { ServiceConfigIssue } from "./_feature-helpers.ts";
import {
  type ListenerContract,
  assertListenerConfig,
  parseWildcardBind,
  plannedPort,
} from "./_port-helpers.ts";

export const MAILPIT_LISTENER: ListenerContract = {
  port: MAILPIT_SMTP_PORT,
  daemon: "mailpit",
  bindVariables: ["MP_SMTP_BIND_ADDR"],
  when: "All Mailpit services; HTTP reservations follow the effective UI bind",
  reserved: [{ port: MAILPIT_WEB_PORT, use: "HTTP UI listener" }],
};
export const MAILHOG_LISTENER: ListenerContract = {
  port: MAILPIT_SMTP_PORT,
  daemon: "mailhog",
  bindVariables: ["MH_SMTP_BIND_ADDR"],
  when: "All MailHog services; HTTP reservations follow the effective UI/API binds",
  reserved: [{ port: MAILPIT_WEB_PORT, use: "HTTP UI listener" }],
};

const nativeBind = (service: ServiceConfig, variable: string, fallback: string) =>
  parseWildcardBind(service.environment?.[variable] ?? fallback, variable);

export const resolveMailListeners = (service: ServiceConfig, type: "mailpit" | "mailhog") => {
  const prefix = type === "mailpit" ? "MP" : "MH";
  const listener = type === "mailpit" ? MAILPIT_LISTENER : MAILHOG_LISTENER;
  const smtpPort = plannedPort(service, listener);
  const smtpVariable = `${prefix}_SMTP_BIND_ADDR`;
  const smtp = nativeBind(service, smtpVariable, `0.0.0.0:${smtpPort}`);
  const ui = nativeBind(service, `${prefix}_UI_BIND_ADDR`, `0.0.0.0:${MAILPIT_WEB_PORT}`);
  const api =
    type === "mailhog" ? nativeBind(service, "MH_API_BIND_ADDR", `0.0.0.0:${MAILPIT_WEB_PORT}`) : ui;
  if (ui.address !== api.address && ui.port === api.port) {
    throw new ServiceConfigIssue(
      ["environment", "MH_API_BIND_ADDR"],
      "MailHog opens separate HTTP sockets when UI and API bind addresses differ, but their ports collide.",
      "Use identical MH_UI_BIND_ADDR and MH_API_BIND_ADDR strings to share one listener, or use distinct ports.",
    );
  }
  assertListenerConfig(service, {
    ...listener,
    reserved: [
      { port: ui.port, use: "HTTP UI listener" },
      { port: api.port, use: "HTTP API listener" },
    ],
  });
  const endpoints: readonly EndpointPlan[] = [
    { _tag: "internal", port: PortNumber.make(smtpPort), protocol: "tcp", name: "smtp", primary: true },
    { _tag: "internal", port: ui.port, protocol: "http", name: "ui", scan: { path: "/" } },
    ...(ui.address === api.address
      ? []
      : [
          {
            _tag: "internal" as const,
            port: api.port,
            protocol: "http" as const,
            name: "api",
            scan: { path: "/api/v2/messages" },
          },
        ]),
  ];
  return { smtpAddress: smtp.address, endpoints };
};
