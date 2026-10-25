import * as net from "node:net";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import type {
	EnterpriseUpstreamConfig,
	Hysteria2UpstreamConfig,
	LlmTunnelConfig,
	UpstreamConfig,
	VlessUpstreamConfig,
	WireguardUpstreamConfig,
} from "./types";

/**
 * Parses a vless:// URL into a VlessUpstreamConfig object.
 * Format: vless://uuid@host:port?param=val#tag
 */
export function parseVlessUrl(rawUrl: string, defaultName = "vless-upstream"): VlessUpstreamConfig {
	const parsed = new URL(rawUrl);
	const uuid = decodeURIComponent(parsed.username);
	const server = parsed.hostname;
	const port = parsed.port ? Number.parseInt(parsed.port, 10) : 443;
	const tag = parsed.hash ? decodeURIComponent(parsed.hash.slice(1)) : defaultName;
	const params = parsed.searchParams;

	const securityParam = params.get("security");
	let security: "reality" | "tls" | "none" = "none";
	if (securityParam === "reality") security = "reality";
	else if (securityParam === "tls") security = "tls";

	const networkParam = params.get("type");
	let network: "tcp" | "grpc" | "ws" = "tcp";
	if (networkParam === "grpc") network = "grpc";
	else if (networkParam === "ws") network = "ws";

	return {
		name: tag || defaultName,
		type: "vless",
		url: rawUrl,
		server,
		port,
		uuid,
		flow: params.get("flow") ?? undefined,
		security,
		sni: params.get("sni") ?? undefined,
		fingerprint: params.get("fp") ?? undefined,
		publicKey: params.get("pbk") ?? undefined,
		shortId: params.get("sid") ?? undefined,
		network,
		path: params.get("path") ?? undefined,
		serviceName: params.get("serviceName") ?? undefined,
		spiderX: params.get("spx") ?? undefined,
		encryption: params.get("encryption") ?? undefined,
	};
}

/**
 * Parses a hy2:// or hysteria2:// URL into a Hysteria2UpstreamConfig object.
 * Format: hy2://password@host:port?sni=...&insecure=1#tag
 */
export function parseHysteria2Url(rawUrl: string, defaultName = "hy2-upstream"): Hysteria2UpstreamConfig {
	const normalized = rawUrl.startsWith("hy2://") ? `hysteria2://${rawUrl.slice(6)}` : rawUrl;
	const parsed = new URL(normalized);
	const password = decodeURIComponent(parsed.username || parsed.password);
	const server = parsed.hostname;
	const port = parsed.port ? Number.parseInt(parsed.port, 10) : 443;
	const tag = parsed.hash ? decodeURIComponent(parsed.hash.slice(1)) : defaultName;
	const params = parsed.searchParams;

	return {
		name: tag || defaultName,
		type: "hysteria2",
		url: rawUrl,
		server,
		port,
		password,
		sni: params.get("sni") ?? undefined,
		insecure: params.get("insecure") === "1" || params.get("insecure") === "true",
	};
}

/**
 * Parses subscription content (multi-line URLs or base64-encoded) into UpstreamConfigs.
 */
export function parseSubscriptionContent(content: string, defaultPrefix = "sub"): UpstreamConfig[] {
	let text = content.trim();
	if (!text) return [];

	if (!text.includes("://") || !text.includes("\n")) {
		try {
			const decoded = Buffer.from(text, "base64").toString("utf8");
			if (decoded.includes("://")) {
				text = decoded.trim();
			}
		} catch {
			// Not base64
		}
	}

	const lines = text
		.split(/\r?\n/)
		.map(l => l.trim())
		.filter(l => Boolean(l) && !l.startsWith("#"));
	const upstreams: UpstreamConfig[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const name = `${defaultPrefix}-${i + 1}`;
		try {
			if (line.startsWith("vless://")) {
				upstreams.push(parseVlessUrl(line, name));
			} else if (line.startsWith("hy2://") || line.startsWith("hysteria2://")) {
				upstreams.push(parseHysteria2Url(line, name));
			} else if (line.startsWith("http://") || line.startsWith("https://") || line.startsWith("socks5://")) {
				const u = new URL(line);
				upstreams.push({
					name: u.hash ? decodeURIComponent(u.hash.slice(1)) : name,
					type: line.startsWith("socks5://") ? "socks5" : "enterprise",
					url: line,
					endpoint: `${u.hostname}:${u.port || (line.startsWith("https://") ? 443 : 80)}`,
					username: u.username ? decodeURIComponent(u.username) : undefined,
					password: u.password ? decodeURIComponent(u.password) : undefined,
				});
			}
		} catch {
			// Skip malformed entry
		}
	}

	return upstreams;
}

/**
 * Fetches a subscription URL and parses its proxy nodes.
 */
export async function fetchSubscriptionUpstreams(url: string, fetchImpl?: typeof fetch): Promise<UpstreamConfig[]> {
	const doFetch = fetchImpl ?? fetch;
	let res: Response;
	try {
		res = await doFetch(url, {
			headers: {
				"User-Agent": "v2rayN/6.23 clash.meta sing-box/1.14.4",
				Accept: "*/*",
			},
			signal: AbortSignal.timeout(15000),
			tls: { rejectUnauthorized: false },
		} as RequestInit);
	} catch (err) {
		throw new Error(
			`Connection to subscription server failed: ${err instanceof Error ? err.message : String(err)}. Check the URL or paste base64/vless content directly.`,
		);
	}
	if (!res.ok) {
		throw new Error(`Subscription server returned HTTP ${res.status} ${res.statusText}`);
	}
	const text = await res.text();
	let prefix = "sub";
	try {
		prefix = new URL(url).hostname || "sub";
	} catch {
		// Keep default
	}
	return parseSubscriptionContent(text, prefix);
}

/**
 * Detects active local proxy listeners (Happ on 127.0.0.1:10809, Hiddify on 2080, Clash on 7890).
 */
export async function detectLocalProxyGateways(): Promise<EnterpriseUpstreamConfig[]> {
	const candidates = [
		{ name: "happ-local", port: 10809 },
		{ name: "hiddify-local", port: 2080 },
		{ name: "clash-local", port: 7890 },
	];
	const found: EnterpriseUpstreamConfig[] = [];
	for (const c of candidates) {
		const isOpen = await new Promise<boolean>(resolve => {
			const s = net.connect(c.port, "127.0.0.1", () => {
				s.destroy();
				resolve(true);
			});
			s.on("error", () => resolve(false));
			s.setTimeout(200, () => {
				s.destroy();
				resolve(false);
			});
		});
		if (isOpen) {
			found.push({
				name: c.name,
				type: "http",
				endpoint: `127.0.0.1:${c.port}`,
			});
		}
	}
	return found;
}
/**
 * Normalizes an UpstreamConfig by parsing its url if fields are not explicitly set.
 */
export function normalizeUpstreamConfig(upstream: UpstreamConfig): UpstreamConfig {
	if (upstream.type === "vless" && upstream.url && !upstream.server) {
		const parsed = parseVlessUrl(upstream.url, upstream.name);
		return { ...parsed, ...upstream, server: parsed.server, port: parsed.port, uuid: parsed.uuid };
	}
	if (upstream.type === "hysteria2" && upstream.url && !upstream.server) {
		const parsed = parseHysteria2Url(upstream.url, upstream.name);
		return { ...parsed, ...upstream, server: parsed.server, port: parsed.port, password: parsed.password };
	}
	return upstream;
}

/**
 * Generates a sing-box outbound configuration object for a given upstream.
 */
export function buildSingBoxOutbound(upstream: UpstreamConfig): Record<string, unknown> {
	const normalized = normalizeUpstreamConfig(upstream);

	switch (normalized.type) {
		case "vless": {
			const vless = normalized as VlessUpstreamConfig;
			const outbound: Record<string, unknown> = {
				type: "vless",
				tag: vless.name,
				server: vless.server,
				server_port: vless.port ?? 443,
				uuid: vless.uuid,
			};

			if (vless.flow) {
				outbound.flow = vless.flow;
			}

			if (vless.security === "reality") {
				outbound.tls = {
					enabled: true,
					server_name: vless.sni,
					reality: {
						enabled: true,
						public_key: vless.publicKey,
						short_id: vless.shortId,
					},
					utls: {
						enabled: true,
						fingerprint: vless.fingerprint ?? "chrome",
					},
				};
			} else if (vless.security === "tls") {
				outbound.tls = {
					enabled: true,
					server_name: vless.sni,
					utls: {
						enabled: true,
						fingerprint: vless.fingerprint ?? "chrome",
					},
				};
			}

			if (vless.network === "grpc") {
				outbound.transport = {
					type: "grpc",
					service_name: vless.serviceName ?? "",
				};
			} else if (vless.network === "ws") {
				outbound.transport = {
					type: "ws",
					path: vless.path ?? "/",
				};
			}

			return outbound;
		}

		case "hysteria2": {
			const hy2 = normalized as Hysteria2UpstreamConfig;
			const outbound: Record<string, unknown> = {
				type: "hysteria2",
				tag: hy2.name,
				server: hy2.server,
				server_port: hy2.port ?? 443,
				password: hy2.password,
			};

			if (hy2.sni || hy2.insecure) {
				outbound.tls = {
					enabled: true,
					server_name: hy2.sni,
					insecure: hy2.insecure,
				};
			}

			return outbound;
		}

		case "enterprise":
		case "http":
		case "https": {
			const ent = normalized as EnterpriseUpstreamConfig;
			let server = "";
			let port = 8080;

			if (ent.endpoint) {
				const parts = ent.endpoint.split(":");
				server = parts[0] ?? "";
				port = parts[1] ? Number.parseInt(parts[1], 10) : 8080;
			} else if (ent.url) {
				const u = new URL(ent.url);
				server = u.hostname;
				port = u.port ? Number.parseInt(u.port, 10) : u.protocol === "https:" ? 443 : 80;
			}

			const outbound: Record<string, unknown> = {
				type: "http",
				tag: ent.name,
				server,
				server_port: port,
			};

			if (ent.username) outbound.username = ent.username;
			if (ent.password) outbound.password = ent.password;
			if (ent.headers) outbound.headers = ent.headers;

			return outbound;
		}

		case "socks5": {
			const ent = normalized as EnterpriseUpstreamConfig;
			let server = "";
			let port = 1080;

			if (ent.endpoint) {
				const parts = ent.endpoint.split(":");
				server = parts[0] ?? "";
				port = parts[1] ? Number.parseInt(parts[1], 10) : 1080;
			} else if (ent.url) {
				const u = new URL(ent.url);
				server = u.hostname;
				port = u.port ? Number.parseInt(u.port, 10) : 1080;
			}

			const outbound: Record<string, unknown> = {
				type: "socks",
				tag: ent.name,
				server,
				server_port: port,
			};

			if (ent.username) outbound.username = ent.username;
			if (ent.password) outbound.password = ent.password;

			return outbound;
		}

		case "wireguard": {
			const wg = normalized as WireguardUpstreamConfig;
			return {
				type: "wireguard",
				tag: wg.name,
				server: wg.server,
				server_port: wg.port ?? 51820,
				system_interface: false,
				private_key: wg.privateKey,
				peer_public_key: wg.peerPublicKey,
				local_address: wg.localAddress ? [wg.localAddress] : undefined,
				pre_shared_key: wg.presharedKey,
				mtu: wg.mtu ?? 1420,
			};
		}
	}
}

/**
 * Builds the complete sing-box configuration object with mixed inbound and outbound list.
 */
export function buildSingBoxConfig(
	listenPort: number,
	upstreams: readonly UpstreamConfig[],
	activeTag?: string,
): Record<string, unknown> {
	const seenTags = new Set<string>();
	const dedupedSingbox = upstreams.filter(u => {
		if (seenTags.has(u.name)) return false;
		seenTags.add(u.name);
		return true;
	});
	const outbounds = dedupedSingbox.map(u => buildSingBoxOutbound(u));

	// Default selector or direct fallback
	const tags = dedupedSingbox.map(u => u.name);
	const selectorOutbound: Record<string, unknown> = {
		type: "selector",
		tag: "proxy-selector",
		outbounds: tags,
		default: activeTag ?? tags[0],
	};

	const directOutbound: Record<string, unknown> = {
		type: "direct",
		tag: "direct",
	};

	return {
		log: {
			disabled: true,
			level: "warn",
		},
		inbounds: [
			{
				type: "mixed",
				tag: "mixed-in",
				listen: "127.0.0.1",
				listen_port: listenPort,
			},
		],
		outbounds: [selectorOutbound, ...outbounds, directOutbound],
		route: {
			rules: [
				{
					inbound: "mixed-in",
					outbound: "proxy-selector",
				},
			],
			auto_detect_interface: true,
		},
	};
}

/**
 * Generates an Xray outbound configuration object for a given upstream.
 */
export function buildXrayOutbound(upstream: UpstreamConfig): Record<string, unknown> {
	const normalized = normalizeUpstreamConfig(upstream);
	if (normalized.type === "vless") {
		const v = normalized as VlessUpstreamConfig;
		const realitySettings: Record<string, unknown> = {
			show: false,
			fingerprint: v.fingerprint ?? "firefox",
			serverName: v.sni,
			publicKey: v.publicKey,
			shortId: v.shortId ?? "",
		};
		if (v.spiderX) realitySettings.spiderX = v.spiderX;

		return {
			tag: v.name,
			protocol: "vless",
			settings: {
				vnext: [
					{
						address: v.server,
						port: v.port ?? 443,
						users: [
							{
								id: v.uuid,
								flow: v.flow ?? undefined,
								encryption: v.encryption ?? "none",
							},
						],
					},
				],
			},
			streamSettings: {
				network: v.network ?? "tcp",
				security: v.security === "reality" ? "reality" : v.security === "tls" ? "tls" : "none",
				...(v.security === "reality" ? { realitySettings } : {}),
				...(v.security === "tls"
					? { tlsSettings: { serverName: v.sni, fingerprint: v.fingerprint ?? "chrome" } }
					: {}),
				...(v.network === "grpc" ? { grpcSettings: { serviceName: v.serviceName ?? "" } } : {}),
				...(v.network === "ws" ? { wsSettings: { path: v.path ?? "/" } } : {}),
			},
		};
	}
	if (normalized.type === "http" || normalized.type === "enterprise") {
		const ep = normalized.endpoint || normalized.url || "127.0.0.1:8080";
		const [server, portStr] = ep.replace(/^https?:\/\//, "").split(":");
		return {
			tag: normalized.name,
			protocol: "http",
			settings: {
				servers: [
					{
						address: server,
						port: Number.parseInt(portStr ?? "80", 10),
					},
				],
			},
		};
	}
	return {
		tag: normalized.name,
		protocol: "freedom",
		settings: {},
	};
}

/**
 * Builds the complete Xray configuration object with HTTP inbound and outbound list.
 */
export function buildXrayConfig(
	listenPort: number,
	upstreams: readonly UpstreamConfig[],
	activeTag?: string,
): Record<string, unknown> {
	const seen = new Set<string>();
	const deduped = upstreams.filter(u => {
		if (seen.has(u.name)) return false;
		seen.add(u.name);
		return true;
	});
	const active = activeTag ? deduped.find(u => u.name === activeTag) : deduped[0];
	const otherUpstreams = deduped.filter(u => u.name !== active?.name);
	const ordered = active ? [active, ...otherUpstreams] : deduped;

	return {
		log: { loglevel: "warning" },
		inbounds: [
			{
				port: listenPort,
				listen: "127.0.0.1",
				protocol: "http",
				settings: {},
			},
		],
		outbounds: [...ordered.map(u => buildXrayOutbound(u)), { tag: "direct", protocol: "freedom" }],
	};
}

/**
 * Loads tunnel configuration from omp.yaml, ~/.omp/tunnel.yaml, or global config.
 */
export async function loadTunnelConfig(customPath?: string): Promise<LlmTunnelConfig | null> {
	const candidates: string[] = [];
	if (customPath) candidates.push(customPath);

	const cwd = process.cwd();
	candidates.push(
		path.join(cwd, "omp.yaml"),
		path.join(cwd, "omp.yml"),
		path.join(cwd, "omp.json"),
		path.join(path.dirname(getAgentDir()), "tunnel.yaml"),
		path.join(path.dirname(getAgentDir()), "tunnel.yml"),
		path.join(path.dirname(getAgentDir()), "tunnel.json"),
		path.join(getAgentDir(), "tunnel.yaml"),
		path.join(getAgentDir(), "tunnel.yml"),
		path.join(getAgentDir(), "tunnel.json"),
		path.join(getAgentDir(), "config.yaml"),
		path.join(getAgentDir(), "config.yml"),
	);

	for (const candidate of candidates) {
		try {
			const file = Bun.file(candidate);
			if (!(await file.exists())) continue;

			const text = await file.text();
			const parsed = candidate.endsWith(".json") ? JSON.parse(text) : YAML.parse(text);
			if (!parsed || typeof parsed !== "object") continue;

			const rawTunnel = (parsed as Record<string, unknown>).llm_tunnel ?? parsed;
			if (!rawTunnel || typeof rawTunnel !== "object") continue;

			const t = rawTunnel as Record<string, unknown>;
			const rawUpstreams = Array.isArray(t.upstreams) ? t.upstreams : [];
			const upstreams: UpstreamConfig[] = [];

			for (const u of rawUpstreams) {
				if (!u || typeof u !== "object") continue;
				const item = u as Record<string, unknown>;
				const rawType = String(item.type ?? "http");
				if (rawType === "subscription" && item.url) {
					try {
						const subNodes = await fetchSubscriptionUpstreams(String(item.url));
						upstreams.push(...subNodes);
					} catch {
						// Ignore unreachable subscription during parse
					}
					continue;
				}

				const type = rawType as UpstreamConfig["type"];
				const name = String(item.name ?? `${type}-${upstreams.length + 1}`);

				if (type === "vless") {
					upstreams.push(
						normalizeUpstreamConfig({
							name,
							type: "vless",
							url: item.url ? String(item.url) : undefined,
							server: item.server ? String(item.server) : undefined,
							port: item.port ? Number(item.port) : undefined,
							uuid: item.uuid ? String(item.uuid) : undefined,
							flow: item.flow ? String(item.flow) : undefined,
							security: item.security as VlessUpstreamConfig["security"],
							sni: item.sni ? String(item.sni) : undefined,
							publicKey:
								item.public_key || item.publicKey ? String(item.public_key || item.publicKey) : undefined,
							shortId: item.short_id || item.shortId ? String(item.short_id || item.shortId) : undefined,
							network: item.network as VlessUpstreamConfig["network"],
							path: item.path ? String(item.path) : undefined,
							serviceName:
								item.service_name || item.serviceName
									? String(item.service_name || item.serviceName)
									: undefined,
						}),
					);
				} else if (type === "hysteria2" || (type as string) === "hy2") {
					upstreams.push(
						normalizeUpstreamConfig({
							name,
							type: "hysteria2",
							url: item.url ? String(item.url) : undefined,
							server: item.server ? String(item.server) : undefined,
							port: item.port ? Number(item.port) : undefined,
							password: item.password ? String(item.password) : undefined,
							sni: item.sni ? String(item.sni) : undefined,
							insecure: Boolean(item.insecure),
						}),
					);
				} else {
					upstreams.push({
						name,
						type,
						endpoint: item.endpoint ? String(item.endpoint) : undefined,
						url: item.url ? String(item.url) : undefined,
						username: item.username ? String(item.username) : undefined,
						password: item.password ? String(item.password) : undefined,
						headers: item.headers as Record<string, string> | undefined,
					});
				}
			}

			const subList: string[] = [];
			if (typeof t.subscription_url === "string") subList.push(t.subscription_url);
			if (typeof t.subscriptionUrl === "string") subList.push(t.subscriptionUrl);
			if (Array.isArray(t.subscriptions)) {
				for (const s of t.subscriptions) if (typeof s === "string") subList.push(s);
			}
			if (Array.isArray(t.subscription_urls)) {
				for (const s of t.subscription_urls) if (typeof s === "string") subList.push(s);
			}
			for (const subUrl of subList) {
				try {
					const subNodes = await fetchSubscriptionUpstreams(subUrl);
					upstreams.push(...subNodes);
				} catch {
					// Ignore unreachable subscription during parse
				}
			}

			return {
				enabled: t.enabled !== false,
				strategy: (t.strategy as LlmTunnelConfig["strategy"]) ?? "failover",
				healthCheckIntervalMs:
					typeof t.health_check_interval === "string"
						? parseDurationToMs(t.health_check_interval)
						: typeof t.health_check_interval === "number"
							? t.health_check_interval
							: undefined,
				canaryUrl: t.canary_url ? String(t.canary_url) : undefined,
				singBoxPath: t.sing_box_path ? String(t.sing_box_path) : undefined,
				upstreams,
				subscriptions: subList.length > 0 ? subList : undefined,
			};
		} catch {
			// Skip and continue to next candidate
		}
	}

	return null;
}

/**
 * Saves tunnel configuration to ~/.omp/tunnel.yaml.
 */
export async function saveTunnelConfig(config: LlmTunnelConfig): Promise<void> {
	const targetPath = path.join(path.dirname(getAgentDir()), "tunnel.yaml");
	const lines: string[] = [
		"# Generated by vomp /vpn TUI",
		"llm_tunnel:",
		`  enabled: ${config.enabled}`,
		`  strategy: "${config.strategy ?? "failover"}"`,
	];
	if (config.canaryUrl) {
		lines.push(`  canary_url: "${config.canaryUrl}"`);
	}
	if (config.healthCheckIntervalMs) {
		lines.push(`  health_check_interval: ${config.healthCheckIntervalMs}ms`);
	}
	if (config.subscriptions && config.subscriptions.length > 0) {
		lines.push("  subscriptions:");
		for (const s of config.subscriptions) {
			lines.push(`    - "${s}"`);
		}
	}
	if (config.upstreams && config.upstreams.length > 0) {
		lines.push("  upstreams:");
		for (const u of config.upstreams) {
			lines.push(`    - name: "${u.name}"`);
			lines.push(`      type: "${u.type}"`);
			if ("url" in u && u.url) lines.push(`      url: "${u.url}"`);
			if (u.type === "vless") {
				const v = u as VlessUpstreamConfig;
				if (v.server) lines.push(`      server: "${v.server}"`);
				if (v.port) lines.push(`      port: ${v.port}`);
				if (v.uuid) lines.push(`      uuid: "${v.uuid}"`);
				if (v.security) lines.push(`      security: "${v.security}"`);
				if (v.sni) lines.push(`      sni: "${v.sni}"`);
				if (v.publicKey) lines.push(`      public_key: "${v.publicKey}"`);
				if (v.shortId) lines.push(`      short_id: "${v.shortId}"`);
				if (v.network) lines.push(`      network: "${v.network}"`);
				if (v.serviceName) lines.push(`      service_name: "${v.serviceName}"`);
			} else if (u.type === "hysteria2") {
				const h = u as Hysteria2UpstreamConfig;
				if (h.server) lines.push(`      server: "${h.server}"`);
				if (h.port) lines.push(`      port: ${h.port}`);
				if (h.password) lines.push(`      password: "${h.password}"`);
				if (h.sni) lines.push(`      sni: "${h.sni}"`);
				if (h.insecure) lines.push(`      insecure: true`);
			}
		}
	}
	await Bun.write(targetPath, lines.join("\n") + "\n");
}

/**
 * Deletes tunnel configuration files from ~/.omp/tunnel.yaml.
 */
export async function deleteTunnelConfig(): Promise<void> {
	const candidates = [
		path.join(path.dirname(getAgentDir()), "tunnel.yaml"),
		path.join(path.dirname(getAgentDir()), "tunnel.yml"),
		path.join(getAgentDir(), "tunnel.yaml"),
		path.join(getAgentDir(), "tunnel.yml"),
	];
	for (const candidate of candidates) {
		try {
			const f = Bun.file(candidate);
			if (await f.exists()) {
				await f.delete?.();
			}
		} catch {
			// Ignore deletion error
		}
	}
}

function parseDurationToMs(dur: string): number {
	const trimmed = dur.trim();
	if (trimmed.endsWith("ms")) return Number.parseInt(trimmed, 10);
	if (trimmed.endsWith("s")) return Number.parseInt(trimmed, 10) * 1000;
	if (trimmed.endsWith("m")) return Number.parseInt(trimmed, 10) * 60_000;
	return Number.parseInt(trimmed, 10) || 15_000;
}
