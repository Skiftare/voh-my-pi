import { register } from "../config/registry";

export const cfgTunnelEnabled = register({
	id: "tunnel.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "providers",
		group: "LLM Split-Tunnel",
		label: "Enabled",
		description: "Enable user-space split-networking tunnel for LLM provider traffic",
	},
});

export const cfgTunnelStrategy = register({
	id: "tunnel.strategy",
	type: "string",
	default: "failover",
	ui: {
		tab: "providers",
		group: "LLM Split-Tunnel",
		label: "Strategy",
		description: "Strategy for selecting upstream node (failover or lowest_latency)",
	},
});

export const cfgTunnelSubscriptionUrl = register({
	id: "tunnel.subscriptionUrl",
	type: "string",
	default: undefined,
	ui: {
		tab: "providers",
		group: "LLM Split-Tunnel",
		label: "Subscription URL",
		description: "Subscription URL providing VLESS or Hysteria2 proxy nodes",
	},
});

export const cfgTunnelCanaryUrl = register({
	id: "tunnel.canaryUrl",
	type: "string",
	default: undefined,
	ui: {
		tab: "providers",
		group: "LLM Split-Tunnel",
		label: "Canary URL",
		description: "Endpoint used for health check probes through the active upstream",
	},
});
