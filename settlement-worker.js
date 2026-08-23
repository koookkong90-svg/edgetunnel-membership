// Isolated frequency-layered settlement worker.
//
// This worker only exposes a `scheduled` entry (no public fetch API). It imports the
// layered settlement runner from membership-settlement.js and never touches _worker.js,
// the Pages proxy path, or the legacy daily settlement runner.
import { runFrequencyLayeredSettlement } from './membership-settlement.js';

function safeErrorSummary(error) {
	const raw = String(error?.code || error?.message || error || 'unknown');
	return raw
		.replace(/cus_[A-Za-z0-9_-]{6,}/g, '<cus>')
		.replace(/membership:[a-z-]+:[A-Za-z0-9_:-]*/g, '<kv-key>')
		.slice(0, 200);
}

export default {
	async scheduled(controller, env, ctx) {
		const startedAt = Date.now();
		const scheduledTime = controller && Number.isSafeInteger(controller.scheduledTime) && controller.scheduledTime > 0
			? controller.scheduledTime
			: Date.now();
		const summary = {
			ok: false,
			cutoffMs: null,
			queryCount: 0,
			customerCount: 0,
			settledCount: 0,
			notDueCount: 0,
			skippedCount: 0,
			failedCount: 0,
			addedBytes: 0,
			durationMs: 0,
		};
		try {
			const result = await runFrequencyLayeredSettlement({ env, nowMs: scheduledTime });
			Object.assign(summary, {
				ok: result.ok === true,
				cutoffMs: Number.isSafeInteger(result.cutoffMs) ? result.cutoffMs : null,
				queryCount: result.queryCount ?? 0,
				customerCount: result.customerCount ?? 0,
				settledCount: result.settledCount ?? 0,
				notDueCount: result.notDueCount ?? 0,
				skippedCount: result.skippedCount ?? 0,
				failedCount: result.failedCount ?? 0,
				addedBytes: result.addedBytes ?? 0,
			});
			if (!result.ok) summary.error = safeErrorSummary(result.skipped || result.error || 'unknown');
		} catch (error) {
			summary.error = safeErrorSummary(error);
		}
		summary.durationMs = Date.now() - startedAt;
		console.log(`[membership-frequency-settlement] ${JSON.stringify(summary)}`);
	},
};
