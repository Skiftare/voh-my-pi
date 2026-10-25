import { describe, expect, it } from "bun:test";
import { BUILTIN_TUNNEL_SLASH_COMMANDS } from "../src/slash-commands/builtin-tunnel";
import { setTunnelManagerForTest } from "../src/tunnel/coordinator";
import { UpstreamManager } from "../src/tunnel/manager";
describe("slash-commands/tunnel", () => {
	it("registers /tunnel slash command with /vpn alias", () => {
		const cmd = BUILTIN_TUNNEL_SLASH_COMMANDS.find(c => c.name === "tunnel");
		expect(cmd).toBeDefined();
		expect(cmd?.aliases).toContain("vpn");
		expect(cmd?.allowArgs).toBe(true);
	});

	it("handles tunnel status gracefully when tunnel is not running", async () => {
		setTunnelManagerForTest(new UpstreamManager({ enabled: false, upstreams: [] }));
		const cmd = BUILTIN_TUNNEL_SLASH_COMMANDS.find(c => c.name === "tunnel")!;
		let outputText = "";
		const mockRuntime = {
			output: async (text: string) => {
				outputText = text;
			},
		};

		await cmd.handle?.({ name: "tunnel", args: "", text: "/tunnel" } as never, mockRuntime as never);
		expect(outputText).toContain("is not configured yet");
		setTunnelManagerForTest(null);
	});
});
