import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { getTunnelManager } from "./coordinator";

/**
 * Wraps a {@link StreamFn} with real-time tunnel telemetry:
 * - Estimates outbound request payload size (prompt + messages)
 * - Records TTFT (Time To First Token) reported by provider or measured wall-clock
 * - Estimates inbound response bytes from streamed chunks and token counts
 * - Automatically feeds telemetry into the active tunnel manager
 */
export function wrapStreamFnWithTunnelTelemetry(base: StreamFn): StreamFn {
	return async (model, context, options) => {
		const tunnelManager = getTunnelManager();
		if (!tunnelManager) {
			return base(model, context, options);
		}

		const startTime = performance.now();

		// Estimate outbound request size in bytes
		let approxOutBytes = 0;
		if (context.systemPrompt) {
			approxOutBytes += context.systemPrompt.reduce((acc, s) => acc + s.length, 0);
		}

		if (context.messages) {
			for (const m of context.messages) {
				if (typeof m.content === "string") {
					approxOutBytes += m.content.length;
				} else if (Array.isArray(m.content)) {
					for (const p of m.content) {
						if (p.type === "text") approxOutBytes += p.text.length;
					}
				}
			}
		}
		// Account for JSON protocol overhead (~15%)
		approxOutBytes = Math.max(256, Math.round(approxOutBytes * 1.15));
		tunnelManager.recordTraffic(0, approxOutBytes);

		const stream = await base(model, context, options);
		stream.result().then(
			msg => {
				const elapsed = Math.round(performance.now() - startTime);
				const ttft = typeof msg.ttft === "number" ? msg.ttft : elapsed;
				tunnelManager.recordTtft(ttft);

				// Inbound response size in bytes
				let approxInBytes = 0;
				if (msg.content) {
					for (const part of msg.content) {
						if (part.type === "text") approxInBytes += part.text.length;
						else if (part.type === "thinking") approxInBytes += part.thinking.length;
					}
				}
				if (msg.usage) {
					approxInBytes = Math.max(approxInBytes, (msg.usage.output ?? 0) * 4);
				}
				approxInBytes = Math.max(64, Math.round(approxInBytes * 1.15));
				tunnelManager.recordTraffic(approxInBytes, 0);
			},
			() => {
				// Ignored; errors handled by caller
			},
		);
		return stream;
	};
}
