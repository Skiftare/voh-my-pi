import { setLlmTunnelProxy } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { fetchSubscriptionUpstreams, parseSubscriptionContent } from "./parser";
import { ensureTunnelRunner, type TunnelRunner } from "./singbox";
import type {
	LlmTunnelConfig,
	TunnelMetrics,
	TunnelStatus,
	TunnelStrategy,
	UpstreamConfig,
	UpstreamMetrics,
} from "./types";

const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 15_000;
const DEFAULT_CANARY_URL = "https://1.1.1.1/cdn-cgi/trace";
const FAILOVER_THRESHOLD = 2;

/**
 * Manages the LLM uplink tunnel:
 * - Upstream node lifecycle & sing-box runner
 * - Periodic background health checks
 * - Auto-respawn and self-healing on runner crash
 * - Auto-failover and lowest-latency selection
 * - Real-time network telemetry (latency, TTFT, in/out bytes, speeds)
 */
export class UpstreamManager {
	#config: LlmTunnelConfig;
	#runner: TunnelRunner | null = null;
	#activeUpstream: UpstreamConfig | null = null;
	#status: TunnelStatus = "idle";
	#strategy: TunnelStrategy;
	#canaryUrl: string;
	#healthCheckTimer: ReturnType<typeof setInterval> | null = null;
	#respawnInProgress = false;

	#upstreamStats = new Map<
		string,
		{
			latencyMs: number | null;
			lastCheck: number | null;
			isAlive: boolean;
			consecutiveFailures: number;
		}
	>();

	// Telemetry & TTFT
	#ttftSamples: number[] = [];
	#lastTtftMs: number | null = null;
	#totalRequests = 0;
	#bytesIn = 0;
	#bytesOut = 0;
	#lastBytesSampleTimestamp = Date.now();
	#lastBytesInSample = 0;
	#lastBytesOutSample = 0;
	#speedKbpsIn = 0;
	#speedKbpsOut = 0;

	constructor(config: LlmTunnelConfig) {
		this.#config = config;
		this.#strategy = config.strategy ?? "failover";
		this.#canaryUrl = config.canaryUrl ?? DEFAULT_CANARY_URL;

		for (const u of config.upstreams) {
			this.#upstreamStats.set(u.name, {
				latencyMs: null,
				lastCheck: null,
				isAlive: true,
				consecutiveFailures: 0,
			});
		}

		if (config.upstreams.length > 0) {
			this.#activeUpstream = config.upstreams[0] ?? null;
		}
	}

	get status(): TunnelStatus {
		return this.#status;
	}

	get activeUpstream(): UpstreamConfig | null {
		return this.#activeUpstream;
	}
	get config(): LlmTunnelConfig {
		return this.#config;
	}

	get upstreams(): readonly UpstreamConfig[] {
		return this.#config.upstreams;
	}

	get strategy(): TunnelStrategy {
		return this.#strategy;
	}

	set strategy(strategy: TunnelStrategy) {
		this.#strategy = strategy;
	}

	addUpstream(upstream: UpstreamConfig): void {
		const existing = this.#config.upstreams.find(u => u.name === upstream.name);
		if (existing) return;
		this.#config = {
			...this.#config,
			upstreams: [...this.#config.upstreams, upstream],
		};
		this.#upstreamStats.set(upstream.name, {
			latencyMs: null,
			lastCheck: null,
			isAlive: true,
			consecutiveFailures: 0,
		});
		if (!this.#activeUpstream) {
			this.#activeUpstream = upstream;
		}
	}
	clearUpstreams(): void {
		this.#config = {
			...this.#config,
			upstreams: [],
			subscriptions: [],
		};
		this.#upstreamStats.clear();
		this.#activeUpstream = null;
		this.#status = "idle";
	}

	removeUpstream(name: string): boolean {
		const existing = this.#config.upstreams.find(u => u.name === name);
		if (!existing) return false;
		this.#config = {
			...this.#config,
			upstreams: this.#config.upstreams.filter(u => u.name !== name),
		};
		this.#upstreamStats.delete(name);
		if (this.#activeUpstream?.name === name) {
			this.#activeUpstream = this.#config.upstreams[0] ?? null;
		}
		return true;
	}

	loadSubscription(content: string, prefix = "sub"): UpstreamConfig[] {
		const parsed = parseSubscriptionContent(content, prefix);
		for (const u of parsed) {
			this.addUpstream(u);
		}
		return parsed;
	}

	async addSubscription(urlOrContent: string, fetchImpl?: typeof fetch): Promise<UpstreamConfig[]> {
		const trimmed = urlOrContent.trim();
		const isHttp = trimmed.startsWith("http://") || trimmed.startsWith("https://");
		const parsed = isHttp ? await fetchSubscriptionUpstreams(trimmed, fetchImpl) : parseSubscriptionContent(trimmed);
		if (parsed.length === 0) {
			throw new Error("No valid proxy nodes found in subscription content or URL");
		}
		const newNames = new Set(parsed.map(u => u.name));
		const kept = this.#config.upstreams.filter(u => !newNames.has(u.name));
		this.#config = {
			...this.#config,
			upstreams: [...parsed, ...kept],
			subscriptions: isHttp
				? Array.from(new Set([...(this.#config.subscriptions ?? []), trimmed]))
				: this.#config.subscriptions,
		};
		for (const u of parsed) {
			this.#upstreamStats.set(u.name, {
				latencyMs: null,
				lastCheck: null,
				isAlive: true,
				consecutiveFailures: 0,
			});
		}
		this.#activeUpstream = parsed[0] ?? null;
		return parsed;
	}

	/**
	 * Returns the local HTTP/SOCKS proxy URL (e.g. http://127.0.0.1:20807) for LLM clients.
	 */
	getProxyUrl(): string | null {
		if (!this.#config.enabled) {
			return null;
		}
		if (this.#activeUpstream?.type === "http" || this.#activeUpstream?.type === "enterprise") {
			const ep = this.#activeUpstream.endpoint || this.#activeUpstream.url;
			if (ep) return ep.startsWith("http://") || ep.startsWith("https://") ? ep : `http://${ep}`;
		}
		if (!this.#runner || !this.#runner.isRunning) {
			return null;
		}
		return `http://127.0.0.1:${this.#runner.port}`;
	}

	/**
	 * Starts the tunnel runner and initializes background health monitoring.
	 */
	async start(): Promise<void> {
		if (!this.#config.enabled || this.#config.upstreams.length === 0) {
			this.#status = "idle";
			return;
		}

		if (this.#activeUpstream?.type === "http" || this.#activeUpstream?.type === "enterprise") {
			this.#status = "healthy";
			const proxyUrl = this.getProxyUrl();
			if (proxyUrl) {
				setLlmTunnelProxy(proxyUrl);
			}
			void this.probeActiveUpstream();
			return;
		}
		try {
			this.#runner = await ensureTunnelRunner(this.#config.singBoxPath);
		} catch (err) {
			this.#status = "down";
			logger.warn("LLM tunnel enabled, but tunnel runner binary could not be initialized", {
				error: String(err),
			});
			return;
		}
		this.#runner.onUnexpectedExit(code => {
			void this.#handleUnexpectedExit(code);
		});

		try {
			const activeTag = this.#activeUpstream?.name;
			await this.#runner.start(this.#config.upstreams, activeTag);
			this.#status = "healthy";

			const proxyUrl = this.getProxyUrl();
			if (proxyUrl) {
				setLlmTunnelProxy(proxyUrl);
			}

			// Perform initial probe in background
			void this.probeActiveUpstream();

			// Start periodic health checking
			const interval = this.#config.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
			this.#healthCheckTimer = setInterval(() => {
				void this.probeActiveUpstream();
			}, interval);
		} catch (err) {
			this.#status = "down";
			logger.error("Failed to start sing-box tunnel", { error: String(err) });
			throw err;
		}
	}

	/**
	 * Stops the runner and background probes.
	 */
	async stop(): Promise<void> {
		setLlmTunnelProxy(null);
		if (this.#healthCheckTimer) {
			clearInterval(this.#healthCheckTimer);
			this.#healthCheckTimer = null;
		}

		if (this.#runner) {
			this.#runner.onUnexpectedExit(null);
			await this.#runner.stop();
			this.#runner = null;
		}

		this.#status = "idle";
	}

	/**
	 * Switches the active upstream manually or during failover.
	 */
	async switchUpstream(targetName: string): Promise<void> {
		const target = this.#config.upstreams.find(u => u.name === targetName);
		if (!target) {
			logger.warn("Target upstream not found in pool", { targetName });
			return;
		}

		this.#activeUpstream = target;
		if (target.type === "http" || target.type === "enterprise") {
			this.#status = "healthy";
			const proxyUrl = this.getProxyUrl();
			if (proxyUrl) {
				setLlmTunnelProxy(proxyUrl);
			}
			logger.info("Active upstream switched to HTTP proxy gateway", { name: target.name });
			return;
		}

		if (this.#runner && this.#runner.isRunning) {
			await this.#runner.switchActive(target.name, this.#config.upstreams);
			const proxyUrl = this.getProxyUrl();
			if (proxyUrl) {
				setLlmTunnelProxy(proxyUrl);
			}
		} else {
			await this.start();
		}
		logger.info("Active upstream switched", { name: target.name, type: target.type });
	}
	/**
	 * Handles unexpected exit / crash of the runner by attempting to respawn.
	 */
	async #handleUnexpectedExit(exitCode: number): Promise<void> {
		if (this.#status === "idle" || this.#respawnInProgress) return;
		this.#respawnInProgress = true;
		this.#status = "connecting";
		logger.warn("Tunnel runner crashed or exited, attempting auto-respawn", { exitCode });

		try {
			for (let attempt = 1; attempt <= 3; attempt++) {
				try {
					await this.#respawnRunner();
					this.#respawnInProgress = false;
					return;
				} catch (err) {
					logger.warn("Tunnel respawn attempt failed", { attempt, error: String(err) });
					await Bun.sleep(250 * attempt);
				}
			}
			logger.error("Tunnel auto-respawn exhausted retries, executing failover");
			await this.#handleFailover();
		} finally {
			this.#respawnInProgress = false;
		}
	}

	/**
	 * Respawns the sing-box process on a fresh ephemeral port and restores LLM proxy state.
	 */
	async #respawnRunner(): Promise<void> {
		if (!this.#runner) return;
		await this.#runner.stop();
		const activeTag = this.#activeUpstream?.name;
		await this.#runner.start(this.#config.upstreams, activeTag);
		const proxyUrl = this.getProxyUrl();
		if (proxyUrl) {
			setLlmTunnelProxy(proxyUrl);
			this.#status = "healthy";
			logger.info("Tunnel runner successfully recovered and respawned", {
				port: this.#runner.port,
				upstream: activeTag,
			});
		}
	}

	/**
	 * Probes the active upstream via the local proxy port.
	 */
	async probeActiveUpstream(): Promise<number | null> {
		if (this.#activeUpstream?.type !== "http" && this.#activeUpstream?.type !== "enterprise") {
			if (this.#runner && !this.#runner.isRunning) {
				void this.#handleUnexpectedExit(-1);
				return null;
			}
		}

		const proxyUrl = this.getProxyUrl();
		if (!proxyUrl || !this.#activeUpstream) {
			return null;
		}

		const currentName = this.#activeUpstream.name;
		const stats = this.#upstreamStats.get(currentName) ?? {
			latencyMs: null,
			lastCheck: null,
			isAlive: true,
			consecutiveFailures: 0,
		};

		const start = performance.now();
		try {
			// Probe through our local mixed proxy
			const res = await fetch(this.#canaryUrl, {
				method: "GET",
				proxy: proxyUrl,
				signal: AbortSignal.timeout(3000),
			});

			const elapsed = Math.round(performance.now() - start);
			stats.latencyMs = elapsed;
			stats.lastCheck = Date.now();
			stats.isAlive = res.ok || res.status < 500;
			stats.consecutiveFailures = 0;
			this.#status = "healthy";

			this.#upstreamStats.set(currentName, stats);
			return elapsed;
		} catch (error) {
			stats.consecutiveFailures++;
			stats.lastCheck = Date.now();
			stats.isAlive = false;
			logger.warn("Tunnel health probe failed", {
				upstream: currentName,
				consecutiveFailures: stats.consecutiveFailures,
				error: String(error),
			});

			this.#upstreamStats.set(currentName, stats);

			if (stats.consecutiveFailures >= FAILOVER_THRESHOLD) {
				await this.#handleFailover();
			} else {
				this.#status = "degraded";
			}

			return null;
		}
	}

	/**
	 * Handles failover to another upstream according to strategy.
	 */
	async #handleFailover(): Promise<void> {
		this.#status = "degraded";
		const candidates = this.#config.upstreams.filter(u => u.name !== this.#activeUpstream?.name);
		if (candidates.length === 0) {
			this.#status = "down";
			logger.error("All upstream nodes in tunnel pool failed");
			return;
		}

		let nextUpstream: UpstreamConfig | undefined;

		if (this.#strategy === "lowest_latency") {
			// Find node with best latency among alive ones, fallback to first
			let bestLatency = Number.POSITIVE_INFINITY;
			for (const c of candidates) {
				const stat = this.#upstreamStats.get(c.name);
				if (stat && stat.isAlive && stat.latencyMs !== null && stat.latencyMs < bestLatency) {
					bestLatency = stat.latencyMs;
					nextUpstream = c;
				}
			}
		}

		// Fallback to sequential failover
		if (!nextUpstream) {
			nextUpstream =
				candidates.find(c => {
					const stat = this.#upstreamStats.get(c.name);
					return !stat || stat.isAlive;
				}) ?? candidates[0];
		}

		if (nextUpstream) {
			logger.info("Executing auto-failover to next upstream", {
				from: this.#activeUpstream?.name,
				to: nextUpstream.name,
			});
			await this.switchUpstream(nextUpstream.name);
		} else {
			this.#status = "down";
		}
	}

	/**
	 * Records time-to-first-token (TTFT) in milliseconds from LLM response streams.
	 */
	recordTtft(ttftMs: number): void {
		if (ttftMs <= 0) return;
		this.#lastTtftMs = Math.round(ttftMs);
		this.#totalRequests += 1;
		this.#ttftSamples.push(this.#lastTtftMs);
		if (this.#ttftSamples.length > 30) {
			this.#ttftSamples.shift();
		}
	}

	/**
	 * Records consumed bytes for throughput/speed telemetry.
	 */
	recordTraffic(bytesIn: number, bytesOut: number): void {
		this.#bytesIn += bytesIn;
		this.#bytesOut += bytesOut;

		const now = Date.now();
		const dt = (now - this.#lastBytesSampleTimestamp) / 1000;
		if (dt >= 1.0) {
			const deltaIn = this.#bytesIn - this.#lastBytesInSample;
			const deltaOut = this.#bytesOut - this.#lastBytesOutSample;

			this.#speedKbpsIn = Math.round(deltaIn / 1024 / dt);
			this.#speedKbpsOut = Math.round(deltaOut / 1024 / dt);

			this.#lastBytesInSample = this.#bytesIn;
			this.#lastBytesOutSample = this.#bytesOut;
			this.#lastBytesSampleTimestamp = now;
		}
	}

	/**
	 * Returns the aggregate metrics snapshot for the status line and TUI.
	 */
	getMetrics(): TunnelMetrics {
		const activeStats = this.#activeUpstream ? this.#upstreamStats.get(this.#activeUpstream.name) : null;

		const upstreamsMetrics: UpstreamMetrics[] = this.#config.upstreams.map(u => {
			const s = this.#upstreamStats.get(u.name);
			return {
				name: u.name,
				type: u.type,
				latencyMs: s?.latencyMs ?? null,
				lastCheckTimestamp: s?.lastCheck ?? null,
				isAlive: s?.isAlive ?? true,
				consecutiveFailures: s?.consecutiveFailures ?? 0,
			};
		});

		const avgTtftMs =
			this.#ttftSamples.length > 0
				? Math.round(this.#ttftSamples.reduce((a, b) => a + b, 0) / this.#ttftSamples.length)
				: null;

		return {
			status: this.#status,
			activeUpstreamName: this.#activeUpstream?.name ?? null,
			activeUpstreamType: this.#activeUpstream?.type ?? null,
			latencyMs: activeStats?.latencyMs ?? null,
			lastTtftMs: this.#lastTtftMs,
			avgTtftMs,
			totalRequests: this.#totalRequests,
			bytesIn: this.#bytesIn,
			bytesOut: this.#bytesOut,
			speedKbpsIn: this.#speedKbpsIn,
			speedKbpsOut: this.#speedKbpsOut,
			upstreams: upstreamsMetrics,
		};
	}
}
