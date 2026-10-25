export type UpstreamType = "vless" | "hysteria2" | "enterprise" | "http" | "https" | "socks5" | "wireguard";

export type TunnelStrategy = "failover" | "lowest_latency";

export interface BaseUpstreamConfig {
	readonly name: string;
	readonly type: UpstreamType;
	readonly enabled?: boolean;
}

export interface VlessUpstreamConfig extends BaseUpstreamConfig {
	readonly type: "vless";
	readonly url?: string;
	readonly server?: string;
	readonly port?: number;
	readonly uuid?: string;
	readonly flow?: string;
	readonly security?: "reality" | "tls" | "none";
	readonly sni?: string;
	readonly fingerprint?: string;
	readonly publicKey?: string;
	readonly shortId?: string;
	readonly network?: "tcp" | "grpc" | "ws";
	readonly path?: string;
	readonly serviceName?: string;
	readonly spiderX?: string;
	readonly encryption?: string;
}

export interface Hysteria2UpstreamConfig extends BaseUpstreamConfig {
	readonly type: "hysteria2";
	readonly url?: string;
	readonly server?: string;
	readonly port?: number;
	readonly password?: string;
	readonly sni?: string;
	readonly insecure?: boolean;
}

export interface EnterpriseUpstreamConfig extends BaseUpstreamConfig {
	readonly type: "enterprise" | "http" | "https" | "socks5";
	readonly endpoint?: string;
	readonly url?: string;
	readonly username?: string;
	readonly password?: string;
	readonly headers?: Record<string, string>;
}

export interface WireguardUpstreamConfig extends BaseUpstreamConfig {
	readonly type: "wireguard";
	readonly server?: string;
	readonly port?: number;
	readonly privateKey?: string;
	readonly peerPublicKey?: string;
	readonly localAddress?: string;
	readonly presharedKey?: string;
	readonly mtu?: number;
}

export type UpstreamConfig =
	| VlessUpstreamConfig
	| Hysteria2UpstreamConfig
	| EnterpriseUpstreamConfig
	| WireguardUpstreamConfig;

export interface LlmTunnelConfig {
	readonly enabled: boolean;
	readonly strategy?: TunnelStrategy;
	readonly healthCheckIntervalMs?: number;
	readonly canaryUrl?: string;
	readonly singBoxPath?: string;
	readonly upstreams: readonly UpstreamConfig[];
	readonly subscriptions?: readonly string[];
}

export type TunnelStatus = "idle" | "connecting" | "healthy" | "degraded" | "down";

export interface UpstreamMetrics {
	readonly name: string;
	readonly type: UpstreamType;
	readonly latencyMs: number | null;
	readonly lastCheckTimestamp: number | null;
	readonly isAlive: boolean;
	readonly consecutiveFailures: number;
}

export interface TunnelMetrics {
	readonly status: TunnelStatus;
	readonly activeUpstreamName: string | null;
	readonly activeUpstreamType: UpstreamType | null;
	readonly latencyMs: number | null;
	readonly lastTtftMs: number | null;
	readonly avgTtftMs: number | null;
	readonly totalRequests: number;
	readonly bytesIn: number;
	readonly bytesOut: number;
	readonly speedKbpsIn: number;
	readonly speedKbpsOut: number;
	readonly upstreams: readonly UpstreamMetrics[];
}
