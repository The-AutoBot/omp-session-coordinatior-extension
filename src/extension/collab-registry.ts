import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export type RegistryHost = Readonly<{
	instanceId: string;
	generation: number;
	inputRequired: boolean;
	sessionId: string;
	connected: boolean;
	access: "control" | "view";
}>;

export type RegistryRoom = Readonly<{ host: RegistryHost; url: string | null }>;
export type RegistryCommand = (args: readonly string[]) => Promise<unknown>;

export type RegistryOutcome = "absent" | "ambiguous" | "disconnected" | "view-only" | "ready";
export type RegistryErrorCode = "invalid-omp-executable" | "omp-executable-unavailable" |
	"collab-registry-timeout" | "collab-registry-nonzero-exit" | "collab-registry-output-limit" |
	"collab-registry-malformed-json" | "invalid-collab-registry-list" | "invalid-collab-registry-link";

export type RegistryFailureDetails = Readonly<{
	registryAttemptId: string;
	registryStage: "list" | "link" | "unknown";
	registryPhase: "validation" | "stat" | "exec" | "parse";
	registryElapsedMs: number;
	registryErrno?: string;
	registrySyscall?: string;
	registrySignal?: string;
	registryExitCode?: number;
	registryKilled?: boolean;
	registryTimeout?: boolean;
	registryStdoutBytes?: number;
	registryStderrBytes?: number;
}>;

const errnos = new Set(["ENOENT", "EACCES", "EPERM", "ENOEXEC", "ENOTDIR", "EISDIR", "E2BIG", "ENOMEM", "EMFILE", "ENFILE", "EBUSY", "ETXTBSY", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]);
const syscalls = new Set(["stat", "access", "spawn"]);
const signals = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV", "SIGHUP", "SIGQUIT", "SIGPIPE"]);
const allowed = (value: unknown, values: ReadonlySet<string>): string =>
	typeof value === "string" && values.has(value) ? value : "UNKNOWN";
const bytes = (value: unknown): number | undefined =>
	typeof value === "string" ? Buffer.byteLength(value) : Buffer.isBuffer(value) ? value.byteLength : undefined;

/** Contains only bounded metadata, never child output, paths, arguments or original cause. */
export class RegistryCommandError extends Error {
	public constructor(public readonly code: RegistryErrorCode, public readonly details?: RegistryFailureDetails) {
		super(code);
		this.name = "RegistryCommandError";
	}
}

export const runCollabRegistryCommand: RegistryCommand = async args => {
	const started = performance.now();
	const registryAttemptId = randomUUID();
	const registryStage = args[0] === "list" || args[0] === "link" ? args[0] : "unknown";
	const failure = (code: RegistryErrorCode, registryPhase: RegistryFailureDetails["registryPhase"], error?: unknown, output?: { stdout: unknown; stderr: unknown }): RegistryCommandError => {
		const raw = record(error) ? error : {};
		const registryStdoutBytes = bytes(output?.stdout ?? raw.stdout);
		const registryStderrBytes = bytes(output?.stderr ?? raw.stderr);
		const details: RegistryFailureDetails = {
			registryAttemptId, registryStage, registryPhase,
			registryElapsedMs: Math.max(0, Math.floor(performance.now() - started)),
			...(raw.code === undefined || typeof raw.code === "number" ? {} : { registryErrno: allowed(raw.code, errnos) }),
			...(raw.syscall === undefined ? {} : { registrySyscall: allowed(raw.syscall, syscalls) }),
			...(raw.signal == null ? {} : { registrySignal: allowed(raw.signal, signals) }),
			...(typeof raw.code === "number" && Number.isSafeInteger(raw.code) ? { registryExitCode: raw.code } : {}),
			...(typeof raw.killed === "boolean" ? { registryKilled: raw.killed } : {}),
			...(registryPhase === "exec" ? { registryTimeout: raw.killed === true && raw.signal === "SIGTERM" } : {}),
			...(registryStdoutBytes === undefined ? {} : { registryStdoutBytes }),
			...(registryStderrBytes === undefined ? {} : { registryStderrBytes }),
		};
		return new RegistryCommandError(code, Object.freeze(details));
	};
	const executable = process.env.OMP_EXECUTABLE;
	if (!executable || !isAbsolute(executable) || /\.(?:cmd|bat)$/i.test(executable) ||
		executable.trim() !== executable ||
		(process.platform === "win32" && !/\.(?:exe|com)$/i.test(executable))) {
		throw failure("invalid-omp-executable", "validation");
	}
	try {
		if (!(await stat(executable)).isFile()) throw failure("invalid-omp-executable", "stat");
		if (process.platform !== "win32") await access(executable, constants.X_OK);
	} catch (error) {
		if (error instanceof RegistryCommandError) throw error;
		throw failure("omp-executable-unavailable", "stat", error);
	}
	let stdout: string;
	let stderr: string;
	try {
		({ stdout, stderr } = await execute(executable, ["collab", ...args], {
			timeout: 4_000,
			maxBuffer: 512 * 1024,
			windowsHide: true,
		}));
	} catch (error) {
		const details = record(error) ? error : {};
		if (details.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
			throw failure("collab-registry-output-limit", "exec", error);
		}
		if (details.killed === true && details.signal === "SIGTERM") {
			throw failure("collab-registry-timeout", "exec", error);
		}
		if (typeof details.code === "number") throw failure("collab-registry-nonzero-exit", "exec", error);
		throw failure("omp-executable-unavailable", "exec", error);
	}
	try {
		return JSON.parse(stdout);
	} catch {
		throw failure("collab-registry-malformed-json", "parse", undefined, { stdout, stderr });
	}
};

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Never resolve a link by PID: an instance ID and generation identify one room. */
export async function discoverLocalCollabRoom(
	sessionId: string,
	pid: number,
	run: RegistryCommand = runCollabRegistryCommand,
	onOutcome?: (outcome: RegistryOutcome) => void,
): Promise<RegistryRoom | null> {
	let validationStarted = performance.now();
	const report = (outcome: RegistryOutcome): void => {
		try { onOutcome?.(outcome); } catch { /* Diagnostic consumers cannot change discovery. */ }
	};
	const listing = await run(["list", "--json"]);
	if (!record(listing) || listing.version !== 1 || !Array.isArray(listing.hosts)) {
		throw new RegistryCommandError("invalid-collab-registry-list", Object.freeze({
			registryAttemptId: randomUUID(), registryStage: "list", registryPhase: "validation",
			registryElapsedMs: Math.max(0, Math.floor(performance.now() - validationStarted)),
		}));
	}
	const matching = listing.hosts.filter((host): host is Record<string, unknown> =>
		record(host) && host.pid === pid && host.sessionId === sessionId &&
		typeof host.instanceId === "string" && /^[\w-]{1,200}$/.test(host.instanceId) &&
		Number.isSafeInteger(host.generation) && (host.generation as number) >= 0 &&
		(host.access === "control" || host.access === "view") &&
		typeof host.relayConnected === "boolean" && typeof host.inputRequired === "boolean",
	);
	// Absence and ambiguity are transient discovery results, not proof of deliberate stop.
	// Never choose among multiple process/session matches or create a replacement host.
	if (matching.length !== 1) {
		report(matching.length === 0 ? "absent" : "ambiguous");
		return null;
	}
	const host = matching[0]!;
	if (host.relayConnected !== true || host.access !== "control") {
		report(host.relayConnected !== true ? "disconnected" : "view-only");
		return { host: {
			instanceId: host.instanceId as string,
			generation: host.generation as number,
			inputRequired: host.inputRequired as boolean,
			sessionId,
			connected: host.relayConnected as boolean,
			access: host.access as "view" | "control",
		}, url: null };
	}
	validationStarted = performance.now();
	const link = await run(["link", host.instanceId as string, "--json"]);
	if (!record(link) || link.version !== 1 || link.instanceId !== host.instanceId ||
		link.generation !== host.generation || link.access !== "control" ||
		typeof link.url !== "string" || link.url.length === 0 || link.url.length > 4096) {
		throw new RegistryCommandError("invalid-collab-registry-link", Object.freeze({
			registryAttemptId: randomUUID(), registryStage: "link", registryPhase: "validation",
			registryElapsedMs: Math.max(0, Math.floor(performance.now() - validationStarted)),
		}));
	}
	report("ready");
	return {
		host: {
			instanceId: host.instanceId as string,
			generation: host.generation as number,
			inputRequired: host.inputRequired as boolean,
			sessionId,
			connected: true,
			access: "control",
		},
		url: link.url,
	};
}
