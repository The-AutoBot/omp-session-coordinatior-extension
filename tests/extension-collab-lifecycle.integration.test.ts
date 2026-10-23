import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { discoverLocalCollabRoom, runCollabRegistryCommand, type RegistryCommand, type RegistryOutcome } from "../src/extension/collab-registry";

const sessionId = "live-session";
const pid = 4711;
// Mirrors CollabHostSnapshot emitted by official `omp collab list --json`.
const host = {
	instanceId: "host-uuid", generation: 4, pid, sessionId, sessionName: null,
	cwd: "/project", model: null, startedAt: 1_700_000_000_000, participants: 1,
	relayConnected: true, inputRequired: false, busy: null, access: "control",
};
const url = "https://agent.example.test/live/#relay.example.test/r/room.secret";

function registry(hosts: unknown[], link: unknown, observed: string[][]): RegistryCommand {
	return async args => {
		observed.push([...args]);
		return args[0] === "list" ? { version: 1, hosts } : link;
	};
}

describe("official OMP collab registry discovery", () => {
	it("resolves only the current process and session and binds the link to its generation", async () => {
		const calls: string[][] = [];
		const room = await discoverLocalCollabRoom(sessionId, pid, registry([
			{ ...host, sessionId: "other-session" },
			{ ...host, pid: 1234 },
			host,
		], { version: 1, instanceId: host.instanceId, generation: 4, access: "control", url }, calls));
		expect(room?.url).toBe(url);
		expect(room?.host).toMatchObject({ generation: 4, connected: true });
		expect(calls).toEqual([["list", "--json"], ["link", host.instanceId, "--json"]]);
		const legacyCalls: string[][] = [];
		const legacy = await discoverLocalCollabRoom(sessionId, pid, registry(
			[{ ...host, connected: false }],
			{ version: 1, instanceId: host.instanceId, generation: 4, access: "control", url },
			legacyCalls,
		));
		expect(legacy?.url).toBe(url);
	});

	it("refuses stale generation or downgraded access rather than publishing successor links", async () => {
		for (const link of [
			{ version: 1, instanceId: host.instanceId, generation: 5, access: "control", url },
			{ version: 1, instanceId: host.instanceId, generation: 4, access: "view", url },
		]) {
			await expect(discoverLocalCollabRoom(sessionId, pid, registry([host], link, [])))
				.rejects.toMatchObject({ code: "invalid-collab-registry-link" });
		}
	});

	it("does not request a link for disappeared, disconnected, view-only, or ambiguous hosts", async () => {
		for (const hosts of [[], [{ ...host, relayConnected: false }], [{ ...host, access: "view" }], [host, host]]) {
			const calls: string[][] = [];
			const room = await discoverLocalCollabRoom(sessionId, pid, registry(hosts, null, calls));
			expect(room?.url ?? null).toBeNull();
			expect(calls).toEqual([["list", "--json"]]);
			if (hosts.length === 1 && (hosts[0] as typeof host).relayConnected === false) {
				expect(room?.host.connected).toBe(false);
			}
		}
	});

	it("does not mistake a legacy connected field for official relay state", async () => {
		const { relayConnected: _relayConnected, ...withoutRelay } = host;
		for (const candidate of [{ ...withoutRelay, connected: true }, { ...host, relayConnected: "true" }]) {
			const calls: string[][] = [];
			expect(await discoverLocalCollabRoom(sessionId, pid, registry([candidate], null, calls))).toBeNull();
			expect(calls).toEqual([["list", "--json"]]);
		}
	});

	it("rejects absent or empty overrides under the development runner and invalid explicit paths", async () => {
		const original = process.env.OMP_EXECUTABLE;
		try {
			for (const value of [undefined, "", " ", "omp", "./omp", resolve("missing-omp.cmd"), process.cwd()]) {
				if (value === undefined) delete process.env.OMP_EXECUTABLE;
				else process.env.OMP_EXECUTABLE = value;
				await expect(runCollabRegistryCommand(["list", "--json"])).rejects.toMatchObject({ code: "invalid-omp-executable" });
			}
		} finally {
			if (original === undefined) delete process.env.OMP_EXECUTABLE;
			else process.env.OMP_EXECUTABLE = original;
		}
	});

	it("classifies unavailable executable separately without exposing its path", async () => {
		const original = process.env.OMP_EXECUTABLE;
		const secretPath = resolve("secret-canary-missing-omp.exe");
		try {
			process.env.OMP_EXECUTABLE = secretPath;
			const error = await runCollabRegistryCommand(["list", "--json"]).catch(error => error);
			if (!(error instanceof Error)) throw new Error("Expected a coded registry failure");
			expect(error).toMatchObject({ code: "omp-executable-unavailable" });
			expect(String(error)).not.toContain(secretPath);
			expect(JSON.stringify(error)).not.toContain("secret-canary");
			expect(error.cause).toBeUndefined();
		} finally {
			if (original === undefined) delete process.env.OMP_EXECUTABLE;
			else process.env.OMP_EXECUTABLE = original;
		}
	});

	it("reports finite discovery outcomes without selecting unavailable rooms even when diagnostics throw", async () => {
		for (const [hosts, expected] of [
			[[], "absent"], [[host, host], "ambiguous"], [[{ ...host, relayConnected: false }], "disconnected"],
			[[{ ...host, access: "view" }], "view-only"], [[host], "ready"],
		] as Array<[unknown[], RegistryOutcome]>) {
			const outcomes: RegistryOutcome[] = [];
			const result = await discoverLocalCollabRoom(sessionId, pid, registry(hosts,
				{ version: 1, instanceId: host.instanceId, generation: 4, access: "control", url }, []),
				outcome => { outcomes.push(outcome); throw new Error("diagnostic-secret-canary"); });
			expect(outcomes).toEqual([expected]);
			expect(result?.url ?? null).toBe(expected === "ready" ? url : null);
		}
	});
});
