import { createHash, timingSafeEqual } from "node:crypto";

import type { MachineCredential } from "./machines";

export const MACHINE_AUTHORIZATION_HEADER = "Authorization";
export const MACHINE_PC_ID_HEADER = "X-OMP-PC-ID";

const PC_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MACHINE_KEY_FORBIDDEN_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\s]/u;
const MINIMUM_MACHINE_KEY_BYTES = 32;
const MAXIMUM_MACHINE_KEY_BYTES = 512;

/** Builds the credential headers required by machine-only WebSocket upgrades. */
export function createMachineHandshakeHeaders(
  pcId: string,
  machineKey: string,
): Readonly<Record<string, string>> {
  return {
    [MACHINE_AUTHORIZATION_HEADER]: `Bearer ${machineKey}`,
    [MACHINE_PC_ID_HEADER]: pcId,
  };
}

/**
 * Authenticates a machine WebSocket upgrade without retaining its credential.
 * The returned PC identifier is safe to bind to the upgraded socket.
 */
export function authenticateMachineHandshake(
  headers: Headers,
  machines: ReadonlyMap<string, MachineCredential>,
): string | null {
  const pcId = headers.get(MACHINE_PC_ID_HEADER);
  const authorization = headers.get(MACHINE_AUTHORIZATION_HEADER);
  if (
    pcId === null ||
    pcId.length > 63 ||
    !PC_ID_PATTERN.test(pcId) ||
    authorization === null ||
    Buffer.byteLength(authorization, "utf8") > MAXIMUM_MACHINE_KEY_BYTES + 7
  ) {
    return null;
  }

  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  const machineKey = match?.[1];
  if (machineKey === undefined || !isValidMachineKey(machineKey)) {
    return null;
  }

  const machine = machines.get(pcId);
  if (machine === undefined || !machine.enabled) {
    return null;
  }

  const candidateDigest = createHash("sha256").update(machineKey, "utf8").digest();
  const expectedDigest = createHash("sha256").update(machine.key, "utf8").digest();
  return timingSafeEqual(expectedDigest, candidateDigest) ? machine.pcId : null;
}

function isValidMachineKey(value: string): boolean {
  if (value.startsWith("replace-with-") || MACHINE_KEY_FORBIDDEN_CHARACTERS.test(value)) {
    return false;
  }
  const byteLength = Buffer.byteLength(value, "utf8");
  return byteLength >= MINIMUM_MACHINE_KEY_BYTES && byteLength <= MAXIMUM_MACHINE_KEY_BYTES;
}
