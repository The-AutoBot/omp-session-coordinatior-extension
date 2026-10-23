import { mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { z } from "zod";

const loopback = (host: string) => ["localhost", "127.0.0.1", "[::1]"].includes(host);
export function dashboardUrl(input: string): URL {
 const url = new URL(input);
 if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname))) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Use an HTTPS dashboard origin (HTTP is allowed only on loopback).");
 return url;
}
const credentialsSchema = z.object({
 dashboard: z.string(), pcId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
 machineKey: z.string().min(32).max(512).regex(/^[^\s\x00-\x1f\x7f]+$/), busEndpoint: z.string(), preferStored: z.boolean().optional(),
});
export type DeviceCredentials = z.infer<typeof credentialsSchema>;
export function validateCredentials(value: unknown): DeviceCredentials {
 const data = credentialsSchema.parse(value);
 const dashboard = dashboardUrl(data.dashboard);
 const bus = new URL(data.busEndpoint);
 if (bus.origin.replace(/^ws/, "http") !== dashboard.origin || bus.pathname !== "/bus" || bus.search || bus.hash || bus.username || bus.password) throw new Error("Invalid enrollment target.");
 return data;
}
export function explicitCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
 return ["OMP_SESSION_BUS_ENDPOINT", "OMP_SESSION_BUS_PC_ID", "OMP_SESSION_BUS_MACHINE_KEY"].some(key => env[key] !== undefined);
}
/** A deliberate stored-mode selection is the only override for explicit launch credentials. */
export function selectStoredCredentials(saved: DeviceCredentials | undefined, env: NodeJS.ProcessEnv = process.env): DeviceCredentials | undefined {
 return saved?.preferStored === true || !explicitCredentials(env) ? saved : undefined;
}
export function credentialPath(): string {
 return join(process.platform === "win32" ? (process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")) : (process.env.XDG_CONFIG_HOME || join(homedir(), ".config")), "omp-session-coordinator", "device.json");
}
export function readCredentials(path = credentialPath()): DeviceCredentials | undefined {
 try { return validateCredentials(JSON.parse(readFileSync(path, "utf8"))); } catch { return undefined; }
}
function protect(path: string): void {
 if (process.platform !== "win32") { chmodSync(path, 0o700); return; }
 const script = "$ErrorActionPreference='Stop'; $p=$env:OMP_ENROLLMENT_PRIVATE_DIRECTORY; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); foreach($s in @($sid,(New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')))) { $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule) }; [System.IO.Directory]::SetAccessControl($p,$acl)";
 const acl = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, env: { ...process.env, OMP_ENROLLMENT_PRIVATE_DIRECTORY: path } });
 if (acl.status !== 0) throw new Error("Unable to protect credential directory.");
}
export function persistCredentials(credentials: DeviceCredentials, path = credentialPath()): void {
 const data = validateCredentials(credentials);
 const directory = join(path, "..");
 mkdirSync(directory, { recursive: true, mode: 0o700 });
 protect(directory);
 const temporary = `${path}.${crypto.randomUUID()}.tmp`;
 let fd: number | undefined;
 try {
  fd = openSync(temporary, "wx", 0o600);
  writeFileSync(fd, JSON.stringify(data)); fsyncSync(fd); closeSync(fd); fd = undefined;
  renameSync(temporary, path);
 } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch {} }
}
export function openVerificationPage(url: URL): void {
 // No shell or command interpolation. Windows rundll32 receives the URL as one argument.
 const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
 const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url.href] : [url.href];
 const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
 child.on("error", () => {}); child.unref();
}
const startSchema = z.object({ deviceCode: z.string().min(32).max(512), userCode: z.string().regex(/^[A-Z0-9-]{4,32}$/), verificationUri: z.string().max(4096), expiresIn: z.number().int().min(1).max(900), interval: z.number().int().min(1).max(30) });
const pollSchema = z.discriminatedUnion("status", [z.object({status:z.literal("pending")}), z.object({status:z.literal("expired")}), z.object({status:z.literal("denied")}), credentialsSchema.omit({dashboard:true}).extend({status:z.literal("approved")})]);
async function post(origin: URL, route: string, body: object, signal: AbortSignal): Promise<Response> {
 return fetch(new URL(route, origin), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
}
async function readEnrollmentResponse(response: Response): Promise<unknown> {
 const reader = response.body?.getReader();
 if (!reader) throw new Error("Missing enrollment response.");
 const bytes = new Uint8Array(16_384);
 let length = 0;
 try {
  for (;;) {
   const chunk = await reader.read();
   if (chunk.done) break;
   if (length + chunk.value.byteLength > bytes.byteLength) throw new Error("Enrollment response too large.");
   bytes.set(chunk.value, length); length += chunk.value.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
 } finally { await reader.cancel(); reader.releaseLock(); }
}
export async function enrollDevice(origin: URL, signal: AbortSignal, show: (url: URL, code: string) => void | Promise<void>): Promise<DeviceCredentials> {
 const startedAt = Date.now();
 const response = await post(origin, "/device/enrollment/start", {}, signal);
 if (!response.ok) throw new Error("Unable to start pairing; retry later.");
 const start = startSchema.parse(await readEnrollmentResponse(response));
 const verification = new URL(start.verificationUri);
 if (verification.origin !== origin.origin || verification.pathname !== "/" || verification.hash || verification.username || verification.password || verification.searchParams.size !== 1 || verification.searchParams.get("pair") !== start.userCode) throw new Error("Invalid pairing link.");
 await show(verification, start.userCode);
 const deadline = startedAt + start.expiresIn * 1000;
 let interval = start.interval * 1000;
 while (Date.now() < deadline) {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const aborted = () => { clearTimeout(timer); reject(new Error("Pairing cancelled.")); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, Math.min(interval, Math.max(0, deadline - Date.now())));
  if (signal.aborted) aborted(); else signal.addEventListener("abort", aborted, {once:true});
  await promise;
  signal.throwIfAborted();
  if (Date.now() >= deadline) break;
  let result: Response;
  try { result = await post(origin, "/device/enrollment/poll", {deviceCode:start.deviceCode}, signal); }
  catch { signal.throwIfAborted(); continue; }
  if (result.status === 429) { interval = Math.min(30_000, interval + 5000); continue; }
  if (!result.ok) throw new Error("Pairing failed; existing connection retained.");
  const state = pollSchema.parse(await readEnrollmentResponse(result));
  if (state.status === "approved") return validateCredentials({...state, dashboard:origin.href});
  if (state.status !== "pending") throw new Error(state.status === "denied" ? "Pairing denied." : "Pairing expired.");
 }
 throw new Error("Pairing expired; run /session-connect to retry.");
}
