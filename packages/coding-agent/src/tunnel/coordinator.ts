import { setLlmTunnelProxy } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { UpstreamManager } from "./manager";
import { loadTunnelConfig } from "./parser";
import type { LlmTunnelConfig } from "./types";

let globalTunnelManager: UpstreamManager | null = null;
let postmortemRegistered = false;

/**
 * Initializes and starts the LLM split-network tunnel if configured.
 * Automatically wires the tunnel proxy into pi-ai's network layer.
 */
export async function initTunnel(customConfigPath?: string): Promise<UpstreamManager | null> {
	if (globalTunnelManager) {
		return globalTunnelManager;
	}

	try {
		const config = await loadTunnelConfig(customConfigPath);
		if (!config || !config.enabled || config.upstreams.length === 0) {
			return null;
		}

		logger.info("Initializing LLM Split-Networking tunnel", {
			upstreamsCount: config.upstreams.length,
			strategy: config.strategy,
		});

		const manager = new UpstreamManager(config);
		await manager.start();

		const proxyUrl = manager.getProxyUrl();
		if (proxyUrl) {
			setLlmTunnelProxy(proxyUrl);
			logger.info("LLM requests redirected through split-tunnel", {
				proxyUrl,
				activeUpstream: manager.activeUpstream?.name,
			});
		}

		if (!postmortemRegistered) {
			postmortem.register("tunnel-stop", () => void stopTunnel(), { exitOnly: true });
			postmortemRegistered = true;
		}

		globalTunnelManager = manager;
		return manager;
	} catch (error) {
		logger.error("Failed to initialize LLM tunnel", { error: String(error) });
		return null;
	}
}

/**
 * Returns the currently running UpstreamManager, or null.
 */
export function getTunnelManager(): UpstreamManager | null {
	return globalTunnelManager;
}

/**
 * Ensures an UpstreamManager instance is active.
 */
export async function ensureTunnelManager(initialConfig?: Partial<LlmTunnelConfig>): Promise<UpstreamManager> {
	if (globalTunnelManager) return globalTunnelManager;

	const loaded = await loadTunnelConfig();
	const config: LlmTunnelConfig = {
		enabled: initialConfig?.enabled ?? loaded?.enabled ?? true,
		strategy: initialConfig?.strategy ?? loaded?.strategy ?? "failover",
		canaryUrl: initialConfig?.canaryUrl ?? loaded?.canaryUrl,
		healthCheckIntervalMs: initialConfig?.healthCheckIntervalMs ?? loaded?.healthCheckIntervalMs,
		singBoxPath: initialConfig?.singBoxPath ?? loaded?.singBoxPath,
		upstreams: initialConfig?.upstreams ?? loaded?.upstreams ?? [],
		subscriptions: initialConfig?.subscriptions ?? loaded?.subscriptions ?? [],
	};

	const manager = new UpstreamManager(config);
	globalTunnelManager = manager;

	if (!postmortemRegistered) {
		postmortem.register("tunnel-stop", () => void stopTunnel(), { exitOnly: true });
		postmortemRegistered = true;
	}

	if (config.enabled && config.upstreams.length > 0) {
		try {
			await manager.start();
			const proxyUrl = manager.getProxyUrl();
			if (proxyUrl) setLlmTunnelProxy(proxyUrl);
		} catch (err) {
			logger.warn("Could not auto-start tunnel runner", { error: String(err) });
		}
	}

	return manager;
}

/**
 * Sets the active manager instance for testing.
 */
export function setTunnelManagerForTest(manager: UpstreamManager | null): void {
	globalTunnelManager = manager;
}

/**
 * Stops the tunnel, restores unproxied state in pi-ai, and cleans up resources.
 */
export async function stopTunnel(): Promise<void> {
	if (!globalTunnelManager) return;

	try {
		setLlmTunnelProxy(null);
		await globalTunnelManager.stop();
	} catch (err) {
		logger.warn("Error while stopping tunnel", { error: String(err) });
	} finally {
		globalTunnelManager = null;
	}
}
