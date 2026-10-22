export interface MachineCredential {
  readonly pcId: string;
  readonly displayName?: string;
  readonly key: string;
  readonly enabled: boolean;
}

const PC_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const MACHINE_DISPLAY_NAME_FORBIDDEN_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/u;
export const MAXIMUM_MACHINE_DISPLAY_NAME_LENGTH = 200;
const MACHINE_KEY_FORBIDDEN_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\s]/u;
const MINIMUM_MACHINE_KEY_BYTES = 32;
const MAXIMUM_MACHINE_KEY_BYTES = 512;
const MAXIMUM_MACHINE_COUNT = 10_000;
const textEncoder = new TextEncoder();

/**
 * Parses the complete machine registry. A missing registry is deliberately an
 * error: each enrolled PC must authenticate with its own independently issued
 * key rather than a shared fallback credential.
 */
export function parseMachineCredentials(value: string | undefined): ReadonlyMap<string, MachineCredential> {
  if (value === undefined || value.length === 0) {
    throw new Error("OMP_SESSION_BUS_MACHINES must define every enrolled PC; no shared machine credential fallback exists.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("OMP_SESSION_BUS_MACHINES must be valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAXIMUM_MACHINE_COUNT) {
    throw new Error("OMP_SESSION_BUS_MACHINES must be a non-empty array.");
  }

  const machines = new Map<string, MachineCredential>();
  const keys = new Set<string>();
  for (const candidate of parsed) {
    if (typeof candidate !== "object" || candidate === null) {
      throw new Error("OMP_SESSION_BUS_MACHINES contains an invalid, duplicate, or unsafe PC credential.");
    }
    const displayName = parseMachineDisplayName(candidate);
    if (
      !("pcId" in candidate) || !("key" in candidate) || !("enabled" in candidate) ||
      typeof candidate.pcId !== "string" || !PC_ID_PATTERN.test(candidate.pcId) ||
      !isValidMachineKey(candidate.key) ||
      typeof candidate.enabled !== "boolean" || displayName === null ||
      machines.has(candidate.pcId) || keys.has(candidate.key)
    ) {
      throw new Error("OMP_SESSION_BUS_MACHINES contains an invalid, duplicate, or unsafe PC credential.");
    }
    const credential: MachineCredential = {
      pcId: candidate.pcId,
      ...(displayName === undefined ? {} : { displayName }),
      key: candidate.key,
      enabled: candidate.enabled,
    };
    machines.set(credential.pcId, credential);
    keys.add(credential.key);
  }
  return machines;
}

function parseMachineDisplayName(candidate: object): string | undefined | null {
  if (!("displayName" in candidate)) {
    return undefined;
  }
  if (typeof candidate.displayName !== "string") {
    return null;
  }

  if (MACHINE_DISPLAY_NAME_FORBIDDEN_CHARACTERS.test(candidate.displayName)) {
    return null;
  }

  const displayName = candidate.displayName.trim();
  if (displayName.length === 0 || displayName.length > MAXIMUM_MACHINE_DISPLAY_NAME_LENGTH) {
    return null;
  }
  return displayName;
}

function isValidMachineKey(value: unknown): value is string {
  if (typeof value !== "string" || value.startsWith("replace-with-") || MACHINE_KEY_FORBIDDEN_CHARACTERS.test(value)) {
    return false;
  }
  const byteLength = textEncoder.encode(value).byteLength;
  return byteLength >= MINIMUM_MACHINE_KEY_BYTES && byteLength <= MAXIMUM_MACHINE_KEY_BYTES;
}