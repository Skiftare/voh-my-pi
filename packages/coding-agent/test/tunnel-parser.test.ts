import { describe, expect, it } from "bun:test";
import { buildSingBoxConfig, buildSingBoxOutbound, parseHysteria2Url, parseVlessUrl } from "../src/tunnel/parser";
import type { EnterpriseUpstreamConfig, VlessUpstreamConfig } from "../src/tunnel/types";

describe("tunnel/parser", () => {
	it("parses vless url with reality and grpc", () => {
		const rawUrl =
			"vless://12345678-1234-1234-1234-123456789abc@my-vps.com:443?security=reality&sni=yahoo.com&fp=chrome&pbk=testpubkey&sid=testsid&type=grpc&serviceName=testgrpc#vless-primary";
		const parsed = parseVlessUrl(rawUrl);

		expect(parsed.name).toBe("vless-primary");
		expect(parsed.type).toBe("vless");
		expect(parsed.server).toBe("my-vps.com");
		expect(parsed.port).toBe(443);
		expect(parsed.uuid).toBe("12345678-1234-1234-1234-123456789abc");
		expect(parsed.security).toBe("reality");
		expect(parsed.sni).toBe("yahoo.com");
		expect(parsed.fingerprint).toBe("chrome");
		expect(parsed.publicKey).toBe("testpubkey");
		expect(parsed.shortId).toBe("testsid");
		expect(parsed.network).toBe("grpc");
		expect(parsed.serviceName).toBe("testgrpc");

		const outbound = buildSingBoxOutbound(parsed);
		expect(outbound.type).toBe("vless");
		expect(outbound.tag).toBe("vless-primary");
		expect(outbound.server).toBe("my-vps.com");
		expect(outbound.server_port).toBe(443);
		expect(outbound.uuid).toBe("12345678-1234-1234-1234-123456789abc");

		const tls = outbound.tls as Record<string, unknown>;
		expect(tls.enabled).toBe(true);
		expect(tls.server_name).toBe("yahoo.com");
		const reality = tls.reality as Record<string, unknown>;
		expect(reality.enabled).toBe(true);
		expect(reality.public_key).toBe("testpubkey");
		expect(reality.short_id).toBe("testsid");

		const transport = outbound.transport as Record<string, unknown>;
		expect(transport.type).toBe("grpc");
		expect(transport.service_name).toBe("testgrpc");
	});

	it("parses hysteria2 url", () => {
		const rawUrl = "hy2://secretpass@my-vps2.com:8443?sni=example.com&insecure=1#hy2-backup";
		const parsed = parseHysteria2Url(rawUrl);

		expect(parsed.name).toBe("hy2-backup");
		expect(parsed.type).toBe("hysteria2");
		expect(parsed.server).toBe("my-vps2.com");
		expect(parsed.port).toBe(8443);
		expect(parsed.password).toBe("secretpass");
		expect(parsed.sni).toBe("example.com");
		expect(parsed.insecure).toBe(true);

		const outbound = buildSingBoxOutbound(parsed);
		expect(outbound.type).toBe("hysteria2");
		expect(outbound.tag).toBe("hy2-backup");
		expect(outbound.server).toBe("my-vps2.com");
		expect(outbound.password).toBe("secretpass");
	});

	it("builds enterprise / http proxy outbound", () => {
		const ent: EnterpriseUpstreamConfig = {
			name: "corp-gateway",
			type: "enterprise",
			endpoint: "10.100.0.5:8080",
			headers: {
				"X-DLP-User": "kbratanov",
			},
		};

		const outbound = buildSingBoxOutbound(ent);
		expect(outbound.type).toBe("http");
		expect(outbound.tag).toBe("corp-gateway");
		expect(outbound.server).toBe("10.100.0.5");
		expect(outbound.server_port).toBe(8080);
		expect(outbound.headers).toEqual({ "X-DLP-User": "kbratanov" });
	});

	it("builds full sing-box config with mixed inbound and proxy-selector", () => {
		const vless: VlessUpstreamConfig = {
			name: "node1",
			type: "vless",
			server: "node1.com",
			port: 443,
			uuid: "uuid-1",
		};
		const config = buildSingBoxConfig(20807, [vless], "node1");

		expect(config.inbounds).toHaveLength(1);
		const inb = (config.inbounds as Array<Record<string, unknown>>)[0]!;
		expect(inb.type).toBe("mixed");
		expect(inb.listen_port).toBe(20807);

		const outbounds = config.outbounds as Array<Record<string, unknown>>;
		expect(outbounds.some(o => o.type === "selector")).toBe(true);
		expect(outbounds.some(o => o.tag === "node1")).toBe(true);
	});

	it("loads and parses tunnel config from yaml file", async () => {
		const tempYamlPath = `${process.cwd()}/test-omp-tunnel.yaml`;
		const yamlContent = `
llm_tunnel:
  enabled: true
  strategy: "lowest_latency"
  health_check_interval: 10s
  upstreams:
    - name: "vless-primary"
      type: "vless"
      url: "vless://11111111-2222-3333-4444-555555555555@example.com:443?security=reality&sni=test.com#vless-primary"
    - name: "hy2-backup"
      type: "hysteria2"
      url: "hy2://pwd@example2.com:443#hy2-backup"
`;
		await Bun.write(tempYamlPath, yamlContent);

		try {
			const { loadTunnelConfig } = await import("../src/tunnel/parser");
			const config = await loadTunnelConfig(tempYamlPath);
			expect(config).not.toBeNull();
			expect(config?.enabled).toBe(true);
			expect(config?.strategy).toBe("lowest_latency");
			expect(config?.healthCheckIntervalMs).toBe(10000);
			expect(config?.upstreams).toHaveLength(2);
			expect(config?.upstreams[0]?.type).toBe("vless");
			expect(config?.upstreams[1]?.type).toBe("hysteria2");
		} finally {
			try {
				const f = Bun.file(tempYamlPath);
				if (await f.exists()) {
					const fs = await import("node:fs/promises");
					await fs.unlink(tempYamlPath);
				}
			} catch {
				// Ignore
			}
		}
	});
});
