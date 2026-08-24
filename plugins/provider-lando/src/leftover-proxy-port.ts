export const LEFTOVER_PROXY_PORT_REMEDIATION =
  "A leftover rootlessport is holding the Traefik loopback ports (127.0.0.1:38080 / 127.0.0.1:38443). Run `lando global:stop`. If that does not release the ports, terminate the leftover rootlessport process manually before retrying. Run `lando setup` if the managed runtime is broken.";

export const isLeftoverProxyPortBindMessage = (message: string): boolean => {
  const mentionsPort = /\b38080\b/.test(message) || /\b38443\b/.test(message);
  if (!mentionsPort) return false;
  return (
    /address already in use/iu.test(message) || /EADDRINUSE/u.test(message) || /rootlessport/iu.test(message)
  );
};
