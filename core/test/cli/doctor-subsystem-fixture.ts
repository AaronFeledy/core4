import * as Router from "@lando/engine/subsystems/proxy/api";
import * as Ssh from "@lando/engine/subsystems/ssh/api";
import { Layer } from "effect";
import { HostDnsResolver } from "../../src/cli/commands/doctor-host-dns.ts";

export const DefaultSubsystemDoctorLayer = Layer.mergeAll(
  Router.layerUnavailable,
  Ssh.layerUnavailable,
  HostDnsResolver.layer,
);
