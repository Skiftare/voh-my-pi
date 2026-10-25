import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { vpnHelp as commandHelp } from "../cli/command-help";
import { ensureTunnelManager, stopTunnel } from "../tunnel/coordinator";
import { deleteTunnelConfig, parseHysteria2Url, parseVlessUrl, saveTunnelConfig } from "../tunnel/parser";

export default class Vpn extends Command {
	static description = commandHelp.description;
	static aliases = ["tunnel"];
	static args = {
		action: Args.string({
			description: "VPN action: status, probe, switch, strategy, sub, add",
			required: false,
		}),
		target: Args.string({
			description: "Target node name, strategy, or URL",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output metrics as JSON" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Vpn);
		const manager = await ensureTunnelManager();
		const action = args.action?.trim() ?? "status";
		const target = args.target?.trim();

		if (manager.upstreams.length === 0 && !target) {
			console.log("VPN Tunnel is not configured yet.");
			console.log("To configure interactively: launch vomp and type /vpn in the chat.");
			console.log("Or add directly from CLI: vomp vpn sub <url> | vomp vpn add <vless://...>");
			return;
		}

		try {
			if (action === "delete" || action === "clear") {
				manager.clearUpstreams();
				await stopTunnel();
				await deleteTunnelConfig();
				console.log("VPN configuration deleted and tunnel stopped.");
				return;
			}

			if (action === "remove" && target) {
				const removed = manager.removeUpstream(target);
				if (removed) {
					if (manager.upstreams.length > 0) {
						await saveTunnelConfig(manager.config);
					} else {
						await stopTunnel();
						await deleteTunnelConfig();
					}
					console.log(`Node '${target}' removed.`);
				} else {
					console.log(`Node '${target}' not found in pool.`);
				}
				return;
			}

			if (action === "probe") {
				console.log("Pinging canary endpoint through active upstream...");
				const lat = await manager.probeActiveUpstream();
				if (lat !== null) console.log(`Canary probe success: ${lat}ms`);
				else console.log("Canary probe failed or timed out.");
				return;
			}
			if (action === "strategy" && target) {
				if (target === "lowest_latency" || target === "failover") {
					manager.strategy = target;
				}
				console.log(`VPN strategy set to: ${manager.strategy}`);
				return;
			}

			if (action === "sub" && target) {
				const added = await manager.addSubscription(target);
				await manager.start();
				await saveTunnelConfig(manager.config);
				console.log(`Added ${added.length} node(s) from subscription: ${target}`);
				return;
			}

			if (action === "add" && target) {
				if (target.startsWith("vless://")) manager.addUpstream(parseVlessUrl(target));
				else if (target.startsWith("hy2://") || target.startsWith("hysteria2://"))
					manager.addUpstream(parseHysteria2Url(target));
				else throw new Error("Expected vless:// or hy2:// URL");
				await manager.start();
				await saveTunnelConfig(manager.config);
				console.log("Added upstream node from URL.");
				return;
			}

			if (action === "switch" && target) {
				await manager.switchUpstream(target);
				console.log(`Switched active upstream to: ${target}`);
				return;
			}

			if (action !== "status" && !target) {
				const node = manager.upstreams.find(u => u.name === action);
				if (node) {
					await manager.switchUpstream(node.name);
					console.log(`Switched active upstream to: ${node.name}`);
					return;
				}
			}

			const metrics = manager.getMetrics();
			if (flags.json) {
				console.log(JSON.stringify(metrics, null, 2));
				return;
			}

			console.log(`=== LLM Split-Networking VPN Tunnel ===`);
			console.log(`Status: [${metrics.status.toUpperCase()}]`);
			console.log(
				`Active Upstream: ${metrics.activeUpstreamName ?? "none"} (${metrics.activeUpstreamType ?? "none"})`,
			);
			console.log(`Latency: ${metrics.latencyMs !== null ? `${metrics.latencyMs}ms` : "untested"}`);
			console.log(`Strategy: ${manager.strategy}`);
			console.log(`Throughput: ↑${metrics.speedKbpsOut} KB/s  ↓${metrics.speedKbpsIn} KB/s`);
			console.log(
				`Traffic: In: ${(metrics.bytesIn / 1024 / 1024).toFixed(2)} MB | Out: ${(metrics.bytesOut / 1024 / 1024).toFixed(2)} MB\n`,
			);
			console.log("Upstreams Pool:");
			for (const u of metrics.upstreams) {
				const isCurrent = u.name === metrics.activeUpstreamName ? " (active)" : "";
				const alive = u.isAlive ? "✓" : "✗";
				const lat = u.latencyMs !== null ? `${u.latencyMs}ms` : "untested";
				console.log(`  [${alive}] ${u.name} (${u.type}) - ${lat}${isCurrent}`);
			}
			console.log(
				`\nCommands: vomp vpn <node> | vomp vpn probe | vomp vpn strategy <failover|lowest_latency> | vomp vpn sub <url>`,
			);
		} finally {
			await stopTunnel();
		}
	}
}
