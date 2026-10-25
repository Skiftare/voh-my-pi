import {
	deleteTunnelConfig,
	detectLocalProxyGateways,
	parseHysteria2Url,
	parseVlessUrl,
	saveTunnelConfig,
} from "../tunnel/parser";
import { ensureTunnelManager, stopTunnel } from "../tunnel/coordinator";
import { clearSubmittedText } from "./helpers/draft";
import { commandConsumed, errorMessage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

const tunnelSpec: SlashCommandSpec = {
	name: "tunnel",
	icon: "globe",
	description: "Manage LLM split-networking VPN tunnel (VLESS, Hysteria2, subscriptions)",
	aliases: ["vpn"],
	inlineHint: "[node | probe | status | strategy | sub | add]",
	allowArgs: true,
	handle: async (command, runtime) => {
		const manager = await ensureTunnelManager();
		const arg = command.args.trim();

		if (manager.upstreams.length === 0 && !arg.startsWith("sub ") && !arg.startsWith("add ")) {
			await runtime.output(
				"LLM Split-Tunnel (VPN) is not configured yet.\nTo configure interactively: open TUI and type /vpn\nOr add directly: /vpn sub <subscription-url> | /vpn add <vless://...>",
			);
			return commandConsumed();
		}
		if (arg === "delete" || arg === "clear") {
			manager.clearUpstreams();
			await stopTunnel();
			await deleteTunnelConfig();
			await runtime.output("VPN tunnel stopped and configuration deleted.");
			return commandConsumed();
		}

		if (arg.startsWith("remove ")) {
			const targetName = arg.slice(7).trim();
			const removed = manager.removeUpstream(targetName);
			if (removed) {
				await saveTunnelConfig(manager.config);
				await runtime.output(`Node '${targetName}' removed.`);
			} else {
				await runtime.output(`Node '${targetName}' not found in pool.`);
			}
			return commandConsumed();
		}

		if (arg === "probe") {
			await runtime.output("Pinging canary endpoint through active upstream...");
			const latency = await manager.probeActiveUpstream();
			if (latency !== null) {
				await runtime.output(`Canary probe success! Active upstream latency: ${latency}ms`);
			} else {
				await runtime.output("Canary probe failed or timed out.");
			}
			return commandConsumed();
		}

		if (arg.startsWith("strategy")) {
			const targetStrategy = arg.replace(/^strategy\s*/, "").trim();
			if (targetStrategy === "lowest_latency" || targetStrategy === "failover") {
				manager.strategy = targetStrategy;
				await saveTunnelConfig(manager.config);
			}
			await runtime.output(`Tunnel strategy: ${manager.strategy}`);
			return commandConsumed();
		}

		if (arg.startsWith("sub ") || arg.startsWith("subscription ")) {
			const subUrl = arg.replace(/^(sub|subscription)\s+/, "").trim();
			try {
				const added = await manager.addSubscription(subUrl);
				await manager.start();
				await saveTunnelConfig(manager.config);
				await runtime.output(`Added ${added.length} node(s) from subscription: ${subUrl}`);
			} catch (err) {
				await runtime.output(`Failed to load subscription: ${errorMessage(err)}`);
			}
			return commandConsumed();
		}

		if (arg.startsWith("add ")) {
			const nodeUrl = arg.slice(4).trim();
			try {
				if (nodeUrl.startsWith("vless://")) manager.addUpstream(parseVlessUrl(nodeUrl));
				else if (nodeUrl.startsWith("hy2://") || nodeUrl.startsWith("hysteria2://"))
					manager.addUpstream(parseHysteria2Url(nodeUrl));
				else throw new Error("Unsupported URL scheme (expected vless:// or hy2://)");
				await manager.start();
				await saveTunnelConfig(manager.config);
				await runtime.output("Added upstream node from URL");
			} catch (err) {
				await runtime.output(`Failed to add node: ${errorMessage(err)}`);
			}
			return commandConsumed();
		}

		if (arg && arg !== "status") {
			try {
				await manager.switchUpstream(arg);
				await runtime.output(`Switched active upstream to: ${arg}`);
			} catch (err) {
				await runtime.output(`Failed to switch upstream: ${errorMessage(err)}`);
			}
			return commandConsumed();
		}

		const metrics = manager.getMetrics();
		const statusEmoji = metrics.status === "healthy" ? "🟢" : metrics.status === "degraded" ? "🟡" : "🔴";

		const lines: string[] = [
			`=== LLM Split-Networking Tunnel ===`,
			`Status: ${statusEmoji} ${metrics.status.toUpperCase()}`,
			`Active Upstream: ${metrics.activeUpstreamName ?? "none"} (${metrics.activeUpstreamType ?? "none"})`,
			`Latency: ${metrics.latencyMs !== null ? `${metrics.latencyMs}ms` : "unknown"}`,
			`TTFT: ${metrics.lastTtftMs !== null ? `${metrics.lastTtftMs}ms (avg: ${metrics.avgTtftMs ?? metrics.lastTtftMs}ms across ${metrics.totalRequests} reqs)` : "none yet"}`,
			`Throughput: ↑${metrics.speedKbpsOut} KB/s  ↓${metrics.speedKbpsIn} KB/s`,
			`Traffic: In: ${(metrics.bytesIn / 1024 / 1024).toFixed(2)} MB | Out: ${(metrics.bytesOut / 1024 / 1024).toFixed(2)} MB`,
			"",
			"Upstreams Pool:",
		];

		for (const u of metrics.upstreams) {
			const isCurrent = u.name === metrics.activeUpstreamName ? " (active)" : "";
			const aliveIcon = u.isAlive ? "✓" : "✗";
			const lat = u.latencyMs !== null ? `${u.latencyMs}ms` : "untested";
			lines.push(`  [${aliveIcon}] ${u.name} (${u.type}) - ${lat}${isCurrent}`);
		}

		lines.push(
			"",
			"Usage: /tunnel <node> | /tunnel probe | /tunnel strategy <failover|lowest_latency> | /tunnel sub <url> | /tunnel add <vless://...>",
		);
		await runtime.output(lines.join("\n"));
		return commandConsumed();
	},
	handleTui: async (command, runtime) => {
		const manager = await ensureTunnelManager();
		const arg = command.args.trim();

		const localGateways = await detectLocalProxyGateways();
		for (const g of localGateways) {
			if (!manager.upstreams.some(u => u.name === g.name)) {
				manager.addUpstream(g);
			}
		}

		if (manager.upstreams.length === 0) {
			if (runtime.ctx.showHookSelector) {
				const choice = await runtime.ctx.showHookSelector("LLM Split-Tunnel (VPN) Setup", [
					"Add Subscription URL (vless/hy2 pool)...",
					"Add Single Node URL (vless:// or hy2://)...",
				]);
				if (choice?.startsWith("Add Subscription") && runtime.ctx.showHookInput) {
					const url = await runtime.ctx.showHookInput("Enter Subscription URL", "https://...");
					if (url?.trim()) {
						runtime.ctx.showStatus("Fetching subscription nodes...");
						try {
							const nodes = await manager.addSubscription(url.trim());
							await manager.start();
							await saveTunnelConfig(manager.config);
							runtime.ctx.showStatus(`Loaded ${nodes.length} nodes from subscription! Tunnel active.`);
						} catch (err) {
							runtime.ctx.showError(`Subscription failed: ${errorMessage(err)}`);
						}
					}
				} else if (choice?.startsWith("Add Single Node") && runtime.ctx.showHookInput) {
					const url = await runtime.ctx.showHookInput("Enter Node URL", "vless://...");
					if (url?.trim()) {
						try {
							const u = url.trim();
							if (u.startsWith("vless://")) manager.addUpstream(parseVlessUrl(u));
							else if (u.startsWith("hy2://") || u.startsWith("hysteria2://"))
								manager.addUpstream(parseHysteria2Url(u));
							else throw new Error("Expected vless:// or hy2:// URL");
							await manager.start();
							await saveTunnelConfig(manager.config);
							runtime.ctx.showStatus("Upstream node added! Tunnel active.");
						} catch (err) {
							runtime.ctx.showError(`Failed to add node: ${errorMessage(err)}`);
						}
					}
				}
			} else {
				runtime.ctx.showStatus("Tunnel has no nodes. Use /vpn sub <url> or /vpn add <url>");
			}
			clearSubmittedText(runtime);
			return;
		}

		if (arg === "probe") {
			runtime.ctx.showStatus("Probing tunnel...");
			const lat = await manager.probeActiveUpstream();
			if (lat !== null) runtime.ctx.showStatus(`Canary probe: ${lat}ms`);
			else runtime.ctx.showError("Canary probe failed");
		} else if (arg.startsWith("strategy")) {
			const targetStrategy = arg.replace(/^strategy\s*/, "").trim();
			if (targetStrategy === "lowest_latency" || targetStrategy === "failover") {
				manager.strategy = targetStrategy;
				await saveTunnelConfig(manager.config);
			}
			runtime.ctx.showStatus(`Tunnel strategy: ${manager.strategy}`);
		} else if (arg.startsWith("sub ") || arg.startsWith("subscription ")) {
			const subUrl = arg.replace(/^(sub|subscription)\s+/, "").trim();
			try {
				const added = await manager.addSubscription(subUrl);
				await manager.start();
				await saveTunnelConfig(manager.config);
				runtime.ctx.showStatus(`Added ${added.length} node(s) from subscription`);
			} catch (err) {
				runtime.ctx.showError(`Subscription error: ${errorMessage(err)}`);
			}
		} else if (arg.startsWith("add ")) {
			const nodeUrl = arg.slice(4).trim();
			try {
				if (nodeUrl.startsWith("vless://")) manager.addUpstream(parseVlessUrl(nodeUrl));
				else if (nodeUrl.startsWith("hy2://") || nodeUrl.startsWith("hysteria2://"))
					manager.addUpstream(parseHysteria2Url(nodeUrl));
				else throw new Error("Expected vless:// or hy2:// URL");
				await manager.start();
				await saveTunnelConfig(manager.config);
				runtime.ctx.showStatus("Upstream node added");
			} catch (err) {
				runtime.ctx.showError(errorMessage(err));
			}
		} else if (arg && arg !== "status" && arg !== "config") {
			try {
				await manager.switchUpstream(arg);
				await saveTunnelConfig(manager.config);
				runtime.ctx.showStatus(`Tunnel switched to ${arg}`);
			} catch (err) {
				runtime.ctx.showError(errorMessage(err));
			}
		} else if (runtime.ctx.showHookSelector) {
			const options = [
				`Switch Node (current: ${manager.activeUpstream?.name ?? "none"})`,
				`Toggle Strategy (current: ${manager.strategy})`,
				"Add Subscription (URL or paste base64)...",
				"Add Node URL (vless/hy2)...",
				"Probe Active Node",
				"Remove Single Upstream Node...",
				"Delete VPN Configuration (Stop & Wipe)",
			];
			const picked = await runtime.ctx.showHookSelector("LLM Tunnel Configuration", options);
			if (picked?.startsWith("Switch Node")) {
				const nodes = manager.upstreams.map(u => u.name);
				const target = await runtime.ctx.showHookSelector("Select Upstream Node", nodes);
				if (target) {
					await manager.switchUpstream(target);
					await saveTunnelConfig(manager.config);
					runtime.ctx.showStatus(`Tunnel switched to ${target}`);
				}
			} else if (picked?.startsWith("Toggle Strategy")) {
				manager.strategy = manager.strategy === "failover" ? "lowest_latency" : "failover";
				await saveTunnelConfig(manager.config);
				runtime.ctx.showStatus(`Strategy switched to ${manager.strategy}`);
			} else if (picked?.startsWith("Add Subscription") && runtime.ctx.showHookInput) {
				const url = await runtime.ctx.showHookInput(
					"Enter Subscription URL or paste base64/vless content",
					"https://... or vless://...",
				);
				if (url?.trim()) {
					runtime.ctx.showStatus("Loading subscription...");
					try {
						const nodes = await manager.addSubscription(url.trim());
						await manager.start();
						await saveTunnelConfig(manager.config);
						runtime.ctx.showStatus(`Loaded ${nodes.length} node(s) from subscription`);
					} catch (err) {
						runtime.ctx.showError(`Subscription failed: ${errorMessage(err)}`);
					}
				}
			} else if (picked?.startsWith("Add Node") && runtime.ctx.showHookInput) {
				const url = await runtime.ctx.showHookInput("Enter Node URL", "vless://...");
				if (url?.trim()) {
					try {
						const u = url.trim();
						if (u.startsWith("vless://")) manager.addUpstream(parseVlessUrl(u));
						else if (u.startsWith("hy2://") || u.startsWith("hysteria2://"))
							manager.addUpstream(parseHysteria2Url(u));
						await manager.start();
						await saveTunnelConfig(manager.config);
						runtime.ctx.showStatus("Upstream node added");
					} catch (err) {
						runtime.ctx.showError(`Failed to add node: ${errorMessage(err)}`);
					}
				}
			} else if (picked?.startsWith("Remove Single Upstream Node")) {
				const nodes = manager.upstreams.map(u => u.name);
				const target = await runtime.ctx.showHookSelector("Select Node to Remove", nodes);
				if (target) {
					manager.removeUpstream(target);
					if (manager.upstreams.length > 0) {
						await saveTunnelConfig(manager.config);
					} else {
						await stopTunnel();
						await deleteTunnelConfig();
					}
					runtime.ctx.showStatus(`Removed node: ${target}`);
				}
			} else if (picked?.startsWith("Delete VPN Configuration")) {
				let confirmed = true;
				if (runtime.ctx.showHookConfirm) {
					confirmed = await runtime.ctx.showHookConfirm(
						"Delete VPN?",
						"Stop tunnel and remove all saved settings?",
					);
				}
				if (confirmed) {
					manager.clearUpstreams();
					await stopTunnel();
					await deleteTunnelConfig();
					runtime.ctx.showStatus("VPN configuration deleted and tunnel stopped.");
				}
			} else if (picked?.startsWith("Probe")) {
				runtime.ctx.showStatus("Probing tunnel...");
				const lat = await manager.probeActiveUpstream();
				if (lat !== null) runtime.ctx.showStatus(`Canary probe: ${lat}ms`);
				else runtime.ctx.showError("Canary probe failed");
			}
		} else {
			const metrics = manager.getMetrics();
			runtime.ctx.showStatus(
				`Tunnel: [${metrics.status}] ${metrics.activeUpstreamName ?? "none"} | ${metrics.latencyMs ?? "?"}ms`,
			);
		}

		clearSubmittedText(runtime);
	},
};

const vpnSpec: SlashCommandSpec = {
	...tunnelSpec,
	name: "vpn",
	aliases: ["tunnel"],
	description: "Manage LLM split-networking VPN tunnel (VLESS, Hysteria2, subscriptions)",
};

export const BUILTIN_TUNNEL_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [tunnelSpec, vpnSpec];
