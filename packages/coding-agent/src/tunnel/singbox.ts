import { $, type Subprocess } from "bun";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import { $which } from "@oh-my-pi/pi-utils";
import { buildSingBoxConfig, buildXrayConfig } from "./parser";
import type { UpstreamConfig } from "./types";

export interface TunnelRunner {
	readonly port: number;
	readonly isRunning: boolean;
	start(upstreams: readonly UpstreamConfig[], activeTag?: string): Promise<number>;
	switchActive(tag: string, upstreams: readonly UpstreamConfig[]): Promise<void>;
	stop(): Promise<void>;
	onUnexpectedExit(callback: ((code: number) => void) | null): void;
}

/**
 * Searches for the sing-box binary on the system:
 * 1. Explicit path in config
 * 2. In PATH
 * 3. In ~/.omp/bin/sing-box(.exe)
 */
export async function findSingBoxBinary(explicitPath?: string): Promise<string | null> {
	if (explicitPath) {
		try {
			await fs.access(explicitPath);
			return explicitPath;
		} catch {
			logger.warn("Specified sing-box path does not exist", { explicitPath });
		}
	}

	const inPath = await $which("sing-box");
	if (inPath) {
		return inPath;
	}
	const binaryName = process.platform === "win32" ? "sing-box.exe" : "sing-box";
	const candidates = [
		path.join(path.dirname(getAgentDir()), "bin", binaryName),
		path.join(getAgentDir(), "bin", binaryName),
	];

	for (const candidate of candidates) {
		try {
			await fs.access(candidate);
			return candidate;
		} catch {
			// Not found
		}
	}

	return null;
}

/**
 * Ensures a sing-box binary is available, automatically downloading it from GitHub releases if missing.
 */
export async function ensureSingBoxBinary(explicitPath?: string): Promise<string> {
	const found = await findSingBoxBinary(explicitPath);
	if (found) return found;

	const binDir = path.join(path.dirname(getAgentDir()), "bin");
	await fs.mkdir(binDir, { recursive: true });

	const version = "1.14.4";
	const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
	const arch = process.arch === "arm64" ? "arm64" : "amd64";
	const ext = platform === "windows" ? ".zip" : ".tar.gz";
	const archiveName = `sing-box-${version}-${platform}-${arch}${ext}`;
	const downloadUrl = `https://github.com/SagerNet/sing-box/releases/download/v${version}/${archiveName}`;

	logger.info("Downloading embedded sing-box tunnel core", { downloadUrl });
	const res = await fetch(downloadUrl);
	if (!res.ok) {
		throw new Error(`Failed to download sing-box core (${res.status} ${res.statusText})`);
	}

	const archivePath = path.join(binDir, `.tmp-${archiveName}`);
	await Bun.write(archivePath, await res.arrayBuffer());

	const binaryName = platform === "windows" ? "sing-box.exe" : "sing-box";
	const finalPath = path.join(binDir, binaryName);

	try {
		await $`tar -xf ${archivePath} -C ${binDir}`.quiet();
		const extractedSubdir = path.join(binDir, `sing-box-${version}-${platform}-${arch}`);
		const candidate = path.join(extractedSubdir, binaryName);
		if (await Bun.file(candidate).exists()) {
			await fs.rename(candidate, finalPath);
			await fs.rm(extractedSubdir, { recursive: true, force: true });
		}
		if (platform !== "windows") {
			await fs.chmod(finalPath, 0o755);
		}
	} finally {
		await fs.rm(archivePath, { force: true });
	}

	return finalPath;
}

export interface TunnelBinaryInfo {
	type: "xray" | "sing-box";
	path: string;
}

/**
 * Searches for an available tunnel core binary, preferring Xray for advanced REALITY and post-quantum support.
 */
export async function findTunnelBinary(explicitPath?: string): Promise<TunnelBinaryInfo | null> {
	if (explicitPath) {
		try {
			await fs.access(explicitPath);
			const type = explicitPath.toLowerCase().includes("xray") ? "xray" : "sing-box";
			return { type, path: explicitPath };
		} catch {
			logger.warn("Specified tunnel binary path does not exist", { explicitPath });
		}
	}

	// 1. Try Xray first
	const xrayName = process.platform === "win32" ? "xray.exe" : "xray";
	const xrayCandidates = [
		path.join(path.dirname(getAgentDir()), "bin", xrayName),
		path.join(getAgentDir(), "bin", xrayName),
		...(process.platform === "win32" ? ["C:\\Program Files\\FlyFrogLLC\\Happ\\core\\xray.exe"] : []),
	];

	for (const candidate of xrayCandidates) {
		try {
			await fs.access(candidate);
			return { type: "xray", path: candidate };
		} catch {
			// Not found
		}
	}

	const inPathXray = await $which("xray");
	if (inPathXray) return { type: "xray", path: inPathXray };

	// 2. Fall back to sing-box
	const singBoxPath = await findSingBoxBinary();
	if (singBoxPath) return { type: "sing-box", path: singBoxPath };

	return null;
}

/**
 * Ensures a TunnelRunner is instantiated with the best available binary.
 */
export async function ensureTunnelRunner(explicitPath?: string): Promise<TunnelRunner> {
	const binaryInfo = await findTunnelBinary(explicitPath);
	if (binaryInfo) {
		return binaryInfo.type === "xray" ? new XrayRunner(binaryInfo.path) : new SingBoxRunner(binaryInfo.path);
	}

	const singBoxPath = await ensureSingBoxBinary();
	return new SingBoxRunner(singBoxPath);
}

/**
 * Manages the lifecycle of an Xray child process.
 */
export class XrayRunner implements TunnelRunner {
	#process: Subprocess | null = null;
	#port = 0;
	#configPath = "";
	#binaryPath = "";
	#activeTag = "";
	#intentionalStop = false;
	#onUnexpectedExit: ((code: number) => void) | null = null;

	constructor(binaryPath: string) {
		this.#binaryPath = binaryPath;
	}

	get port(): number {
		return this.#port;
	}

	get isRunning(): boolean {
		return this.#process !== null && this.#process.exitCode === null;
	}

	onUnexpectedExit(callback: ((code: number) => void) | null): void {
		this.#onUnexpectedExit = callback;
	}

	async start(upstreams: readonly UpstreamConfig[], activeTag?: string): Promise<number> {
		await this.stop();
		this.#intentionalStop = false;

		this.#port = await getEphemeralPort();
		this.#activeTag = activeTag ?? upstreams[0]?.name ?? "default";

		const configDir = path.join(getAgentDir(), "tunnel");
		await fs.mkdir(configDir, { recursive: true });
		this.#configPath = path.join(configDir, `xray-${this.#port}.json`);

		const configObj = buildXrayConfig(this.#port, upstreams, this.#activeTag);
		await Bun.write(this.#configPath, JSON.stringify(configObj, null, 2));

		logger.info("Starting Xray core tunnel runner", {
			binary: this.#binaryPath,
			port: this.#port,
			activeTag: this.#activeTag,
		});

		const child = Bun.spawn([this.#binaryPath, "run", "-c", this.#configPath], {
			stdout: "pipe",
			stderr: "pipe",
		});
		this.#process = child;

		child.exited.then(code => {
			if (!this.#intentionalStop && this.#process === child) {
				logger.warn("xray process exited unexpectedly", { code, port: this.#port });
				this.#process = null;
				this.#onUnexpectedExit?.(code);
			}
		});

		const ready = await waitForPort(this.#port);
		if (!ready) {
			const exitCode = this.#process?.exitCode;
			let errOut = "";
			if (child.stderr && typeof child.stderr !== "number") {
				try {
					errOut = await new Response(child.stderr).text();
				} catch {
					// Ignore
				}
			}
			await this.stop();
			throw new Error(
				`Xray failed to start on 127.0.0.1:${this.#port} (exitCode=${exitCode}): ${errOut.slice(0, 500)}`,
			);
		}

		logger.info("Xray listening successfully", { port: this.#port });
		return this.#port;
	}

	async switchActive(tag: string, upstreams: readonly UpstreamConfig[]): Promise<void> {
		this.#activeTag = tag;
		if (!this.isRunning) return;

		const configObj = buildXrayConfig(this.#port, upstreams, this.#activeTag);
		await Bun.write(this.#configPath, JSON.stringify(configObj, null, 2));

		if (this.#process) {
			this.#intentionalStop = true;
			this.#process.kill();
		}
		this.#intentionalStop = false;

		const child = Bun.spawn([this.#binaryPath, "run", "-c", this.#configPath], {
			stdout: "pipe",
			stderr: "pipe",
		});
		this.#process = child;

		child.exited.then(code => {
			if (!this.#intentionalStop && this.#process === child) {
				this.#process = null;
				this.#onUnexpectedExit?.(code);
			}
		});

		await waitForPort(this.#port);
		logger.info("Xray switched active outbound", { activeTag: tag });
	}

	async stop(): Promise<void> {
		this.#intentionalStop = true;
		if (this.#process) {
			try {
				this.#process.kill();
			} catch {
				// Process might already be dead
			}
			this.#process = null;
		}

		if (this.#configPath) {
			try {
				await fs.unlink(this.#configPath);
			} catch {
				// Ignore
			}
			this.#configPath = "";
		}

		this.#port = 0;
	}
}

/**
 * Finds an available local TCP port on 127.0.0.1.
 */
export async function getEphemeralPort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const srv = net.createServer();

	srv.unref();
	srv.on("error", reject);
	srv.listen(0, "127.0.0.1", () => {
		const addr = srv.address();
		if (!addr || typeof addr === "string") {
			srv.close(() => reject(new Error("Failed to get port from net.Server")));
			return;
		}
		const port = addr.port;
		srv.close(err => {
			if (err) reject(err);
			else resolve(port);
		});
	});

	return promise;
}

/**
 * Waits until the local port starts accepting TCP connections or timeout occurs.
 */
async function waitForPort(port: number, timeoutMs = 3000): Promise<boolean> {
	const startTime = Date.now();
	while (Date.now() - startTime < timeoutMs) {
		const connected = await new Promise<boolean>(res => {
			const socket = new net.Socket();
			socket.setTimeout(250);
			socket.once("connect", () => {
				socket.destroy();
				res(true);
			});
			socket.once("error", () => {
				socket.destroy();
				res(false);
			});
			socket.once("timeout", () => {
				socket.destroy();
				res(false);
			});
			socket.connect(port, "127.0.0.1");
		});

		if (connected) return true;
		await Bun.sleep(50);
	}
	return false;
}

/**
 * Manages the lifecycle of the user-space sing-box child process.
 */
export class SingBoxRunner {
	#process: Subprocess | null = null;
	#port = 0;
	#configPath = "";
	#binaryPath = "";
	#activeTag = "";
	#intentionalStop = false;
	#onUnexpectedExit: ((code: number) => void) | null = null;

	constructor(binaryPath: string) {
		this.#binaryPath = binaryPath;
	}

	get port(): number {
		return this.#port;
	}

	get isRunning(): boolean {
		return this.#process !== null && this.#process.exitCode === null;
	}

	onUnexpectedExit(callback: ((code: number) => void) | null): void {
		this.#onUnexpectedExit = callback;
	}

	/**
	 * Starts the sing-box process with the given upstreams on an ephemeral port.
	 */
	async start(upstreams: readonly UpstreamConfig[], activeTag?: string): Promise<number> {
		await this.stop();
		this.#intentionalStop = false;

		this.#port = await getEphemeralPort();
		this.#activeTag = activeTag ?? upstreams[0]?.name ?? "default";

		const configDir = path.join(getAgentDir(), "tunnel");
		await fs.mkdir(configDir, { recursive: true });
		this.#configPath = path.join(configDir, `sing-box-${this.#port}.json`);

		const configObj = buildSingBoxConfig(this.#port, upstreams, this.#activeTag);
		await Bun.write(this.#configPath, JSON.stringify(configObj, null, 2));

		logger.info("Starting sing-box core", {
			binary: this.#binaryPath,
			port: this.#port,
			activeTag: this.#activeTag,
		});

		const child = Bun.spawn([this.#binaryPath, "run", "-c", this.#configPath], {
			stdout: "pipe",
			stderr: "pipe",
		});
		this.#process = child;

		child.exited.then(code => {
			if (!this.#intentionalStop && this.#process === child) {
				logger.warn("sing-box process exited unexpectedly", { code, port: this.#port });
				this.#process = null;
				this.#onUnexpectedExit?.(code);
			}
		});

		const ready = await waitForPort(this.#port);
		if (!ready) {
			const exitCode = this.#process?.exitCode;
			let errOut = "";
			if (child.stderr && typeof child.stderr !== "number") {
				try {
					errOut = await new Response(child.stderr).text();
				} catch {
					// Ignore
				}
			}
			await this.stop();
			throw new Error(
				`sing-box failed to start on 127.0.0.1:${this.#port} (exitCode=${exitCode}): ${errOut.slice(0, 500)}`,
			);
		}

		logger.info("sing-box listening successfully", { port: this.#port });
		return this.#port;
	}

	/**
	 * Switches the active upstream node by updating config and restarting.
	 */
	async switchActive(tag: string, upstreams: readonly UpstreamConfig[]): Promise<void> {
		this.#activeTag = tag;
		if (!this.isRunning) return;

		const configObj = buildSingBoxConfig(this.#port, upstreams, this.#activeTag);
		await Bun.write(this.#configPath, JSON.stringify(configObj, null, 2));

		// On Windows or general headless, restarting process with new config ensures clean state
		if (this.#process) {
			this.#intentionalStop = true;
			this.#process.kill();
		}
		this.#intentionalStop = false;

		const child = Bun.spawn([this.#binaryPath, "run", "-c", this.#configPath], {
			stdout: "pipe",
			stderr: "pipe",
		});
		this.#process = child;

		child.exited.then(code => {
			if (!this.#intentionalStop && this.#process === child) {
				logger.warn("sing-box process exited unexpectedly", { code, port: this.#port });
				this.#process = null;
				this.#onUnexpectedExit?.(code);
			}
		});

		await waitForPort(this.#port);
		logger.info("sing-box switched active outbound", { activeTag: tag });
	}

	/**
	 * Stops the sing-box process and removes the temporary config.
	 */
	async stop(): Promise<void> {
		this.#intentionalStop = true;
		if (this.#process) {
			try {
				this.#process.kill();
			} catch {
				// Process might already be dead
			}
			this.#process = null;
		}

		if (this.#configPath) {
			try {
				await fs.unlink(this.#configPath);
			} catch {
				// Ignore
			}
			this.#configPath = "";
		}

		this.#port = 0;
	}
}
