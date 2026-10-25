import { describe, expect, it } from "bun:test";
import { UpstreamManager } from "../src/tunnel/manager";
import type { LlmTunnelConfig } from "../src/tunnel/types";

describe("tunnel/manager", () => {
	it("initializes with first upstream and records metrics", () => {
		const config: LlmTunnelConfig = {
			enabled: true,
			strategy: "failover",
			upstreams: [
				{
					name: "primary-vless",
					type: "vless",
					server: "vless.example.com",
					port: 443,
					uuid: "test-uuid",
				},
				{
					name: "backup-hy2",
					type: "hysteria2",
					server: "hy2.example.com",
					port: 8443,
					password: "pwd",
				},
			],
		};

		const manager = new UpstreamManager(config);
		expect(manager.status).toBe("idle");
		expect(manager.activeUpstream?.name).toBe("primary-vless");

		manager.recordTraffic(1024 * 50, 1024 * 10);
		const metrics = manager.getMetrics();

		expect(metrics.activeUpstreamName).toBe("primary-vless");
		expect(metrics.activeUpstreamType).toBe("vless");
		expect(metrics.bytesIn).toBe(51200);
		expect(metrics.bytesOut).toBe(10240);
		expect(metrics.upstreams).toHaveLength(2);
		expect(metrics.upstreams[0]?.name).toBe("primary-vless");
		expect(metrics.upstreams[1]?.name).toBe("backup-hy2");
	});

	it("switches upstream manually", async () => {
		const config: LlmTunnelConfig = {
			enabled: true,
			upstreams: [
				{ name: "node-a", type: "http", endpoint: "10.0.0.1:8080" },
				{ name: "node-b", type: "http", endpoint: "10.0.0.2:8080" },
			],
		};

		const manager = new UpstreamManager(config);
		expect(manager.activeUpstream?.name).toBe("node-a");

		await manager.switchUpstream("node-b");
		expect(manager.activeUpstream?.name).toBe("node-b");

		const metrics = manager.getMetrics();
		expect(metrics.activeUpstreamName).toBe("node-b");
	});

	it("records TTFT samples and calculates rolling average", () => {
		const config: LlmTunnelConfig = {
			enabled: true,
			upstreams: [{ name: "node-1", type: "http", endpoint: "127.0.0.1:8080" }],
		};

		const manager = new UpstreamManager(config);
		expect(manager.getMetrics().lastTtftMs).toBeNull();
		expect(manager.getMetrics().avgTtftMs).toBeNull();
		expect(manager.getMetrics().totalRequests).toBe(0);

		manager.recordTtft(200);
		expect(manager.getMetrics().lastTtftMs).toBe(200);
		expect(manager.getMetrics().avgTtftMs).toBe(200);
		expect(manager.getMetrics().totalRequests).toBe(1);

		manager.recordTtft(400);
		expect(manager.getMetrics().lastTtftMs).toBe(400);
		expect(manager.getMetrics().avgTtftMs).toBe(300);
		expect(manager.getMetrics().totalRequests).toBe(2);
	});
});
