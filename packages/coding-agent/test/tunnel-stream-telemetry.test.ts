import { describe, expect, it } from "bun:test";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai";
import { EventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { UpstreamManager } from "../src/tunnel/manager";
import { wrapStreamFnWithTunnelTelemetry } from "../src/tunnel/stream-telemetry";
import { setTunnelManagerForTest } from "../src/tunnel/coordinator";

describe("tunnel/stream-telemetry", () => {
	it("intercepts stream and feeds TTFT and traffic into active tunnel manager", async () => {
		const manager = new UpstreamManager({
			enabled: true,
			upstreams: [{ name: "node-1", type: "http", endpoint: "127.0.0.1:8080" }],
		});

		setTunnelManagerForTest(manager);

		try {
			const fakeModel: Model<"openai-completions"> = {
				id: "mock-model",
				provider: "mock",
				api: "openai-completions",
				name: "Mock Model",
				baseUrl: "http://mock",
				cost: { input: 0, output: 0 },
				contextWindow: 8192,
				maxTokens: 2048,
			} as unknown as Model<"openai-completions">;

			const fakeContext: Context = {
				systemPrompt: ["You are a helpful assistant."],
				messages: [
					{
						role: "user",
						content: "Hello from test prompt!",
						timestamp: Date.now(),
					},
				],
			};

			const mockBaseStreamFn: StreamFn = () => {
				const stream = new EventStream<never, AssistantMessage>(
					() => true,
					() => ({}) as AssistantMessage,
				);

				// Settle stream after slight delay with TTFT and content
				setTimeout(() => {
					stream.end({
						role: "assistant",
						content: [{ type: "text", text: "Response text tokens generated." }],
						ttft: 185,
						usage: { input: 20, output: 10 },
						timestamp: Date.now(),
					} as AssistantMessage);
				}, 10);

				return stream as never;
			};

			const wrappedFn = wrapStreamFnWithTunnelTelemetry(mockBaseStreamFn);
			const stream = await wrappedFn(fakeModel, fakeContext);
			const result = await (stream as unknown as { result: () => Promise<AssistantMessage> }).result();

			expect(result.ttft).toBe(185);

			// Check manager received TTFT and traffic metrics
			const metrics = manager.getMetrics();
			expect(metrics.lastTtftMs).toBe(185);
			expect(metrics.totalRequests).toBe(1);
			expect(metrics.bytesOut).toBeGreaterThan(0);
			expect(metrics.bytesIn).toBeGreaterThan(0);
		} finally {
			setTunnelManagerForTest(null);
		}
	});
});
