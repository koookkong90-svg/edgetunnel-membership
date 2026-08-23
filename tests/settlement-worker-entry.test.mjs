import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	getLatestClosedBucketEnd,
} from '../membership-settlement.js';

const source = readFileSync(new URL('../settlement-worker.js', import.meta.url), 'utf8');
const workerModule = await import('../settlement-worker.js');
const worker = workerModule.default;

const ACCOUNT_ID = 'a'.repeat(32);
const DATASET = 'membership_usage_test_v1';
const TZ = 'Asia/Shanghai';
const USAGE_KEY = 'membership:usage:';
const CUSTOMER_A = 'cus_aaaaaaaaaaaaaaaaaaaa';
const GIB = 1024 ** 3;
const NOW_MS = Date.UTC(2026, 7, 23, 7, 0, 0);
const CUTOFF = getLatestClosedBucketEnd(NOW_MS, 2);

const POLICY = JSON.stringify({
	bucketHours: 12,
	cronIntervalHours: 12,
	frequencyWindowHours: 24,
	highFrequencyThreshold: 6,
	mediumFrequencyThreshold: 2,
	highSettlementHours: 12,
	mediumSettlementHours: 24,
	lowSettlementHours: 72,
	lookbackHours: 120,
	closedBucketDelayHours: 2,
	timezone: 'Asia/Shanghai',
});

function indexFor(utcMs) {
	return Math.floor((utcMs - 16 * 3600 * 1000) / (12 * 3600 * 1000));
}

function makeUsage() {
	return JSON.stringify({
		schemaVersion: 4,
		kind: 'membership-usage',
		customerId: CUSTOMER_A,
		quotaBytes: 100 * GIB,
		settledUsedBytes: 0,
		quotaExceeded: false,
		usageUpdatedAt: 0,
		usageSettledThrough: CUTOFF - 12 * 3600 * 1000,
		unlimitedTraffic: false,
		revision: 1,
	});
}

function makeKv() {
	const store = new Map([[USAGE_KEY + CUSTOMER_A, makeUsage()]]);
	const calls = { gets: [], puts: [] };
	const kv = {
		async get(key) {
			calls.gets.push(key);
			return store.has(key) ? store.get(key) : null;
		},
		async put(key, value) {
			calls.puts.push(key);
			store.set(key, value);
		},
	};
	kv._calls = calls;
	return kv;
}

function makeEnv({ kv, token = 'test-token' } = {}) {
	return {
		KV: kv,
		MEMBERSHIP_USAGE_ACCOUNT_ID: ACCOUNT_ID,
		MEMBERSHIP_USAGE_API_TOKEN: token,
		MEMBERSHIP_USAGE_DATASET: DATASET,
		MEMBERSHIP_USAGE_SETTLEMENT_ENABLED: 'true',
		MEMBERSHIP_USAGE_SETTLEMENT_TIMEZONE: TZ,
		USAGE_SETTLEMENT_POLICY_JSON: POLICY,
	};
}

function groupedResponse(rows) {
	return {
		status: 200,
		ok: true,
		async text() {
			return JSON.stringify({
				meta: [
					{ name: 'customerId', type: 'String' },
					{ name: 'bucketIndex', type: 'Int64' },
					{ name: 'uploadBytes', type: 'Float64' },
					{ name: 'downloadBytes', type: 'Float64' },
					{ name: 'connectCount', type: 'Float64' },
					{ name: 'latestEventTs', type: 'DateTime' },
				],
				data: rows,
				rows: rows.length,
			});
		},
	};
}

function captureLogs() {
	const logs = [];
	const original = console.log;
	console.log = (...args) => logs.push(args.join(' '));
	return {
		logs,
		restore() {
			console.log = original;
		},
		summary() {
			for (let i = logs.length - 1; i >= 0; i--) {
				const line = logs[i];
				const marker = '[membership-frequency-settlement] ';
				const index = line.indexOf(marker);
				if (index === -1) continue;
				try {
					return JSON.parse(line.slice(index + marker.length));
				} catch (_) {
					// runner 的 info 行不是 JSON，继续向前找
				}
			}
			return null;
		},
	};
}

// ---------------------------------------------------------------------------

test('只导出 scheduled 入口，不导出代理 fetch 入口', () => {
	assert.deepEqual(Object.keys(worker), ['scheduled']);
	assert.ok(!('fetch' in worker), '不得导出 fetch');
});

test('不导入 _worker.js，不引用旧版日结算运行器', () => {
	assert.ok(!/from\s+['"]\.\/_worker\.js['"]/.test(source), '不得 import _worker.js');
	assert.ok(!source.includes('runMembershipUsageSettlement'), '不得引用旧版日结算');
	assert.match(source, /runFrequencyLayeredSettlement/);
});

test('scheduled 使用 controller.scheduledTime 作为本次运行时间', () => {
	assert.match(source, /controller\.scheduledTime/);
	assert.match(source, /nowMs: scheduledTime/);
});

test('scheduled 调用 runFrequencyLayeredSettlement 并输出结构化摘要', async (t) => {
	const kv = makeKv();
	const capture = captureLogs();
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => groupedResponse([
		[CUSTOMER_A, indexFor(CUTOFF - 12 * 3600 * 1000), 100, 50, 12, 1000],
	]);
	try {
		await worker.scheduled({ scheduledTime: NOW_MS }, makeEnv({ kv }), {});
	} finally {
		capture.restore();
		globalThis.fetch = originalFetch;
	}
	const summary = capture.summary();
	assert.ok(summary, '应输出结构化摘要日志');
	assert.equal(summary.ok, true);
	assert.equal(summary.cutoffMs, CUTOFF, 'cutoff 应来自 scheduledTime 计算');
	assert.equal(summary.queryCount, 1);
	assert.equal(summary.customerCount, 1);
	assert.equal(summary.settledCount, 1);
	assert.equal(summary.addedBytes, 150);
	assert.equal(kv._calls.puts.length, 1);
});

test('配置缺失时安全返回摘要且不发起网络请求', async (t) => {
	const kv = makeKv();
	const capture = captureLogs();
	const originalFetch = globalThis.fetch;
	let fetchCalled = false;
	globalThis.fetch = async () => {
		fetchCalled = true;
		throw new Error('should not be called');
	};
	try {
		// 缺少 API Token → validateSettlementConfig 提前返回，不 fetch
		await worker.scheduled({ scheduledTime: NOW_MS }, makeEnv({ kv, token: '' }), {});
	} finally {
		capture.restore();
		globalThis.fetch = originalFetch;
	}
	assert.equal(fetchCalled, false);
	const summary = capture.summary();
	assert.equal(summary.ok, false);
	assert.equal(summary.error, 'missing_api_token');
	assert.equal(summary.customerCount, 0);
});

test('异常摘要不泄露 Secret 或客户数据', async (t) => {
	const kv = makeKv();
	const capture = captureLogs();
	const originalFetch = globalThis.fetch;
	const secretMarker = 'SUPER_SECRET_TOKEN_12345';
	globalThis.fetch = async () => {
		throw new Error(`request failed with ${secretMarker}`);
	};
	try {
		await worker.scheduled({ scheduledTime: NOW_MS }, makeEnv({ kv }), {});
	} finally {
		capture.restore();
		globalThis.fetch = originalFetch;
	}
	const summary = capture.summary();
	assert.equal(summary.ok, false);
	assert.equal(summary.error, 'sql_network', '只记录安全错误码');
	const serialized = JSON.stringify(capture.logs);
	assert.ok(!serialized.includes(secretMarker), '不得泄露 Secret');
	assert.ok(!serialized.includes('cus_'), '不得泄露客户 ID');
	assert.ok(!serialized.includes('uuid'), '不得泄露 UUID');
});

test('摘要日志字段白名单（+安全错误码）', async (t) => {
	const kv = makeKv();
	const capture = captureLogs();
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => groupedResponse([]);
	try {
		await worker.scheduled({ scheduledTime: NOW_MS }, makeEnv({ kv }), {});
	} finally {
		capture.restore();
		globalThis.fetch = originalFetch;
	}
	const summary = capture.summary();
	const allowed = new Set([
		'ok', 'cutoffMs', 'queryCount', 'customerCount', 'settledCount',
		'notDueCount', 'skippedCount', 'failedCount', 'addedBytes', 'durationMs', 'error',
	]);
	for (const key of Object.keys(summary)) {
		assert.ok(allowed.has(key), `日志包含未允许字段: ${key}`);
	}
});
