import {
  type EndpointPlan,
  type GeneratedCertificateEndpoint,
  PortNumber,
  isRootContainerUser,
  normalizeAppSlug,
  serviceInternalAlias,
} from "@lando/sdk/schema";

/** Container port of a generated native-TLS listener when the plain listener is not 443. */
export const APACHE_TLS_PORT = 443 as const;
/** Container port used for native TLS when the plain listener itself occupies 443. */
export const APACHE_TLS_FALLBACK_PORT = 8443 as const;

/** Native TLS listeners never share a container port with the primary plain listener. */
export const generatedTlsListenerPort = (plainPort: number): PortNumber =>
  PortNumber.make(plainPort === APACHE_TLS_PORT ? APACHE_TLS_FALLBACK_PORT : APACHE_TLS_PORT);

/** A generated listener alias that never reuses the primary plain listener's name. */
export const generatedTlsEndpointName = (serviceName: string): string => `${serviceName}-https`;

/**
 * The canonical internal alias a generated certificate names, used as the TLS
 * virtual host's canonical name so a port-less Host still yields port 443.
 */
export const generatedTlsServerName = (input: {
  readonly serviceName: string;
  readonly appName: string;
  readonly appRoot: string;
}): string => serviceInternalAlias(input.serviceName, normalizeAppSlug(input.appName, input.appRoot));

/** Whether the effective service asks for a generated leaf certificate. */
export const generatedCertificateRequested = (config: { readonly certs?: unknown }): boolean =>
  config.certs === true;

/**
 * Whether the Apache parent process runs as root, and can therefore read the
 * Lando-owned private key before workers drop privileges.
 */
export const apacheRunsAsRootParent = (user: string | undefined): boolean =>
  user === undefined || isRootContainerUser(user);

/**
 * Whether a launcher can serve native TLS for this service. A Lando-owned
 * launcher is required, and only a root parent can read the generated key.
 */
export const nativeTlsEligible = (input: {
  readonly owned: boolean;
  readonly config: { readonly user?: string; readonly certs?: unknown };
}): boolean =>
  input.owned && apacheRunsAsRootParent(input.config.user) && generatedCertificateRequested(input.config);

/**
 * The generated-listener association for one Apache-shaped service. It is a
 * capability, not a promise: every Lando-owned launcher carries it, including a
 * launcher whose parent user cannot read the key, so routing can explain the
 * opt-out while the TLS listener itself stays root-only.
 */
export const apacheGeneratedCertificateEndpoint = (input: {
  readonly plainPort: number;
  readonly owned: boolean;
}): GeneratedCertificateEndpoint | undefined =>
  input.owned ? { port: generatedTlsListenerPort(input.plainPort) } : undefined;

/** The declared HTTPS listener that serves a generated certificate. */
export const generatedHttpsEndpoint = (input: {
  readonly serviceName: string;
  readonly plainPort: number;
}): EndpointPlan => ({
  _tag: "internal",
  port: generatedTlsListenerPort(input.plainPort),
  protocol: "https",
  name: generatedTlsEndpointName(input.serviceName),
});

/** The generated listeners and canonical name for one eligible launcher. */
export const nativeTlsListener = (input: {
  readonly plainPort: number;
  readonly serviceName: string;
  readonly appName: string;
  readonly appRoot: string;
}): ApacheNativeTls => ({
  plainPort: PortNumber.make(input.plainPort),
  tlsPort: generatedTlsListenerPort(input.plainPort),
  serverName: generatedTlsServerName(input),
});

/** Native TLS virtual host directives; the certificate pair comes from Lando's generated leaf. */
export const apacheTlsDirectives = (serverName: string): ReadonlyArray<string> => [
  `ServerName ${serverName}:443`,
  "ServerAlias *",
  "SSLEngine on",
  'SSLCertificateFile "${LANDO_SERVICE_CERT}"',
  'SSLCertificateKeyFile "${LANDO_SERVICE_KEY}"',
  // Canonical name and physical port off keep Host authoritative: a port-less
  // Host yields 443, while Host's explicit port still wins.
  "UseCanonicalName Off",
  "UseCanonicalPhysicalPort Off",
];

export interface ApacheNativeTls {
  readonly plainPort: PortNumber;
  readonly tlsPort: PortNumber;
  readonly serverName: string;
}

const PLAIN_SERVER_NAME = "ServerName localhost:80";
const CANONICAL_NAME_OFF = "UseCanonicalName Off";
const CANONICAL_PHYSICAL_PORT_OFF = "UseCanonicalPhysicalPort Off";
const PLAIN_TLS_OFF = "SSLEngine off";

/**
 * The plain listener's canonical-name directives. A custom physical port stays
 * out of self-referencing URLs: a port-less Host yields 80 and a Host port wins.
 */
export const plainListenerCanonicalDirectives: ReadonlyArray<string> = [
  PLAIN_SERVER_NAME,
  CANONICAL_NAME_OFF,
  CANONICAL_PHYSICAL_PORT_OFF,
];

/**
 * Which bundled launcher owns the directive stream. The families emit the same
 * plain-listener directives in the order their launcher has always used.
 */
export type NativeTlsLauncherFamily = "standalone-apache" | "php-apache";

const PLAIN_VHOST_PREAMBLE: Readonly<Record<NativeTlsLauncherFamily, ReadonlyArray<string>>> = {
  "standalone-apache": [PLAIN_SERVER_NAME, PLAIN_TLS_OFF, CANONICAL_NAME_OFF, CANONICAL_PHYSICAL_PORT_OFF],
  "php-apache": [PLAIN_TLS_OFF, ...plainListenerCanonicalDirectives],
};

/**
 * The plain and native-TLS virtual hosts, in their canonical order: the plain
 * listener disables the engine, and the TLS listener is the only host on that
 * port because the stock sample host stays disabled at build time.
 *
 * Each family supplies the site directives it renders per listener; native TLS
 * sets the scheme itself, so a TLS site omits plain-listener-only directives.
 */
export const nativeTlsVirtualHosts = (input: {
  readonly family: NativeTlsLauncherFamily;
  readonly plainPort: PortNumber;
  readonly tlsPort: PortNumber;
  readonly serverName: string;
  readonly plainSite: ReadonlyArray<string>;
  readonly tlsSite: ReadonlyArray<string>;
}): ReadonlyArray<string> => [
  `<VirtualHost *:${String(input.plainPort)}>`,
  ...PLAIN_VHOST_PREAMBLE[input.family],
  ...input.plainSite,
  "</VirtualHost>",
  `<VirtualHost *:${String(input.tlsPort)}>`,
  ...apacheTlsDirectives(input.serverName),
  ...input.tlsSite,
  "</VirtualHost>",
];
