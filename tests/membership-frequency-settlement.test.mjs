import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	runFrequencyLayeredSettlement,
	getLatestClosedBucketEnd,
	frequencyBucketStartMs,
} from '../membership-settlement.js';

const ACCOUNT_ID = 'a'.repeat(32);
const DATASET = 'membership_usage_test_v1';
const TZ = 'Asia/Shanghai';
const USAGE_KEY = 'membership:usage:';
const CUSTOMER_KEY = 'membership:customer:';
const BUCKET_MS = 12 * 3600 * 1000;
const CUSTOMER_A = 'cus_aaaaaaaaaaaaaaaaaaaa';
const CUSTOMER_B = 'cus_bbbbbbbbbbbbbbbbbbbb';
const GIB = 1024 ** 3;

// 2026-08-23 15:00 CST；关闭桶延迟 2h → cutoff 为 2026-08-23 12:00 CST。
const NOW_MS = Date.UTC(2026, 7, 23, 7, 0, 0);
const CUTOFF = getLatestClosedBucketEnd(NOW_MS, 2);
const WINDOW_START = NOW_MS - 96 * 3600 * 1000;

const POLICY = JSON.stringify({
	bucketHours: 12,
	cronIntervalHours: 12,
	frequencyWindowHours: 24,
	highFrequencyThreshold: 10,
	mediumFrequencyThreshold: 5,
	highSettlementHours: 12,
	mediumSettlementHours: 24,
	lowSettlementHours: 72,
	lookbackHours: 96,
	closedBucketDelayHours: 2,
	timezone: 'Asia/Shanghai',
});

function indexFor(utcMs) {
	return Math.floor((utcMs - 16 * 3600 * 1000) / BUCKET_MS);
}

function makeUsage(customerId, overrides = {}) {
	return {
		schemaVersion: 4,
		kind: 'membership-usage',
		customerId,
		quotaBytes: 100 * GIB,
		settledUsedBytes: 0,
		quotaExceeded: false,
		usageUpdatedAt: 0,
		usageSettledThrough: 0,
		unlimitedTraffic: false,
		revision: 1,
		...overrides,
	};
}

function makeCustomer(customerId, overrides = {}) {
	return {
		schemaVersion: 4,
		kind: 'membership-customer',
		customerId,
		name: 'Test User',
		remark: '',
		uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
		tokenHash: '0'.repeat(64),
		tokenPreview: '••••abcd',
		state: 'active',
		enabled: true,
		expiresAt: 1_999_999_999_999,
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		revision: 1,
		disableReason: null,
		...overrides,
	};
}

function createKv(initial = {}) {
	const store = new Map(Object.entries(initial));
	const calls = { gets: [], puts: [], deletes: 0 };
	const hooks = { failGet: new Set(), failPut: new Set(), onRead: null, onPut: null };
	const kv = {
		async get(key) {
			calls.gets.push(key);
			if (hooks.failGet.has(key)) throw new Error('simulated KV get failure');
			const current = store.has(key) ? store.get(key) : null;
			if (typeof hooks.onRead === 'function') {
				const override = hooks.onRead(key, current);
				if (override !== undefined) return override;
			}
			return current;
		},
		async put(key, value) {
			calls.puts.push(key);
			if (hooks.failPut.has(key)) throw new Error('simulated KV put failure');
			if (typeof hooks.onPut === 'function') hooks.onPut(key, value, store);
			store.set(key, value);
		},
		async delete(key) {
			calls.deletes++;
			store.delete(key);
		},
	};
	kv._store = store;
	kv._calls = calls;
	kv._hooks = hooks;
	return kv;
}

function makeEnv({ usage = {}, main = {}, hooks = {}, policy = POLICY } = {}) {
	const initial = {};
	for (const [id, value] of Object.entries(usage)) {
		initial[USAGE_KEY + id] = typeof value === 'string' ? value : JSON.stringify(value);
	}
	for (const [id, value] of Object.entries(main)) {
		initial[CUSTOMER_KEY + id] = typeof value === 'string' ? value : JSON.stringify(value);
	}
	const kv = createKv(initial);
	Object.assign(kv._hooks, hooks);
	return {
		KV: kv,
		MEMBERSHIP_USAGE_ACCOUNT_ID: ACCOUNT_ID,
		MEMBERSHIP_USAGE_API_TOKEN: 'test-token',
		MEMBERSHIP_USAGE_DATASET: DATASET,
		MEMBERSHIP_USAGE_SETTLEMENT_ENABLED: 'true',
		MEMBERSHIP_USAGE_SETTLEMENT_TIMEZONE: TZ,
		USAGE_SETTLEMENT_POLICY_JSON: policy,
	};
}

function jsonResponse(status, payload) {
	return { status, ok: status >= 200 && status < 300, async text() { return JSON.stringify(payload); } };
}

function groupedPayload(rows) {
	return {
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
	};
}

function groupedRows(rows) {
	return jsonResponse(200, groupedPayload(rows));
}

function createFetch(handler) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		const call = { url, init };
		calls.push(call);
		return handler(call, calls.length);
	};
	fetchImpl.calls = calls;
	return fetchImpl;
}

function bucketRow(customerId, { startMs, upload = 0, download = 0, connect = 0, latestTs = 1000 } = {}) {
	return [customerId, indexFor(startMs), upload, download, connect, latestTs];
}

async function run(env, fetchImpl, nowMs = NOW_MS) {
	return runFrequencyLayeredSettlement({ env, fetchImpl, nowMs });
}

function jsonParse(value) {
	return JSON.parse(value);
}

function usageGets(kv) {
	return kv._calls.gets.filter(key => key.startsWith(USAGE_KEY)).length;
}

function usagePuts(kv) {
	return kv._calls.puts.filter(key => key.startsWith(USAGE_KEY)).length;
}

// ---------------------------------------------------------------------------
// 分层周期
// ---------------------------------------------------------------------------

test('高频客户满 12 小时可以结算', async () => {
	const env = makeEnv({
		usage: { [CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: CUTOFF - 12 * 3600 * 1000 }) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 100, download: 50, connect: 12 }),
	]));
	const result = await run(env, fetchImpl);
	assert.equal(result.ok, true);
	assert.equal(result.settledCount, 1);
	const settled = result.results.find(r => r.customerId === CUSTOMER_A);
	assert.equal(settled.status, 'settled');
	assert.equal(settled.addedBytes, 150);
	assert.equal(settled.usageSettledThrough, CUTOFF);
	assert.equal(settled.quotaExceeded, false);
	assert.equal(usagePuts(env.KV), 1);
});

test('高频客户水位已达 cutoff 时不 put（未满 12 小时窗口）', async () => {
	const env = makeEnv({
		usage: { [CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: CUTOFF }) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 10, download: 10, connect: 12 }),
	]));
	const result = await run(env, fetchImpl);
	assert.equal(result.settledCount, 0);
	assert.equal(usagePuts(env.KV), 0);
});

test('中频客户满 24 小时可以结算', async () => {
	const env = makeEnv({
		usage: { [CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: CUTOFF - 24 * 3600 * 1000 }) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 24 * 3600 * 1000, upload: 30, download: 20, connect: 7 }),
	]));
	const result = await run(env, fetchImpl);
	const settled = result.results.find(r => r.customerId === CUSTOMER_A);
	assert.equal(settled.status, 'settled');
	assert.equal(settled.addedBytes, 50);
	assert.equal(usagePuts(env.KV), 1);
});

test('中频客户未满 24 小时不 put', async () => {
	const env = makeEnv({
		usage: { [CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: CUTOFF - 12 * 3600 * 1000 }) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 30, download: 20, connect: 7 }),
	]));
	const result = await run(env, fetchImpl);
	const entry = result.results.find(r => r.customerId === CUSTOMER_A);
	assert.equal(entry.status, 'not_due');
	assert.equal(usagePuts(env.KV), 0);
});

test('低频客户满 72 小时可以结算', async () => {
	const env = makeEnv({
		usage: { [CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: CUTOFF - 72 * 3600 * 1000 }) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 72 * 3600 * 1000, upload: 5, download: 5, connect: 2 }),
	]));
	const result = await run(env, fetchImpl);
	const settled = result.results.find(r => r.customerId === CUSTOMER_A);
	assert.equal(settled.status, 'settled');
	assert.equal(settled.addedBytes, 10);
	assert.equal(usagePuts(env.KV), 1);
});

test('低频客户未满 72 小时不 put', async () => {
	const env = makeEnv({
		usage: { [CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: CUTOFF - 24 * 3600 * 1000 }) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 24 * 3600 * 1000, upload: 5, download: 5, connect: 2 }),
	]));
	const result = await run(env, fetchImpl);
	const entry = result.results.find(r => r.customerId === CUSTOMER_A);
	assert.equal(entry.status, 'not_due');
	assert.equal(usagePuts(env.KV), 0);
});

test('高频本身不会设置 quotaExceeded，也不修改 enabled', async () => {
	const env = makeEnv({
		usage: { [CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: CUTOFF - 12 * 3600 * 1000, quotaBytes: 100 * GIB }) },
		main: { [CUSTOMER_A]: makeCustomer(CUSTOMER_A) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 10, download: 10, connect: 20 }),
	]));
	const result = await run(env, fetchImpl);
	const settled = result.results.find(r => r.customerId === CUSTOMER_A);
	assert.equal(settled.tier, 'high');
	assert.equal(settled.quotaExceeded, false);
	assert.equal(usagePuts(env.KV), 1);
	assert.ok(!env.KV._calls.puts.some(key => key.startsWith(CUSTOMER_KEY)), '不得写客户主记录');
	const storedUsage = jsonParse(env.KV._store.get(USAGE_KEY + CUSTOMER_A));
	assert.ok(!('enabled' in storedUsage), 'usage 记录不应包含 enabled');
	const storedMain = jsonParse(env.KV._store.get(CUSTOMER_KEY + CUSTOMER_A));
	assert.equal(storedMain.enabled, true);
});

// ---------------------------------------------------------------------------
// 桶与累计
// ---------------------------------------------------------------------------

test('只累计 bucketEndMs 大于 usageSettledThrough 的桶', async () => {
	const env = makeEnv({
		usage: { [CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: CUTOFF - 24 * 3600 * 1000 }) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 36 * 3600 * 1000, upload: 999, download: 999, connect: 12 }), // 结束 == 水位 → 排除
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 24 * 3600 * 1000, upload: 40, download: 60, connect: 12 }),
	]));
	const result = await run(env, fetchImpl);
	const settled = result.results.find(r => r.customerId === CUSTOMER_A);
	assert.equal(settled.addedBytes, 100);
});

test('不累计正在进行的桶（截止到已关闭桶）', async () => {
	const env = makeEnv({
		usage: { [CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: CUTOFF - 24 * 3600 * 1000 }) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 40, download: 60, connect: 12 }),
		// 结束晚于 cutoff 的桶不属于本次窗口，即使出现也不得累计
		bucketRow(CUSTOMER_A, { startMs: CUTOFF, upload: 1000, download: 1000, connect: 12 }),
	]));
	const result = await run(env, fetchImpl);
	const settled = result.results.find(r => r.customerId === CUSTOMER_A);
	assert.equal(settled.addedBytes, 100);
});

test('多个 12 小时桶正确求和（upload+download 共同计入）', async () => {
	const env = makeEnv({
		usage: { [CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: CUTOFF - 36 * 3600 * 1000 }) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 36 * 3600 * 1000, upload: 10, download: 20, connect: 12 }),
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 24 * 3600 * 1000, upload: 30, download: 40, connect: 12 }),
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 50, download: 60, connect: 12 }),
	]));
	const result = await run(env, fetchImpl);
	const settled = result.results.find(r => r.customerId === CUSTOMER_A);
	assert.equal(settled.addedBytes, 210);
	assert.equal(settled.uploadBytes, 90);
	assert.equal(settled.downloadBytes, 120);
});

test('connect 零字节事件不增加流量', async () => {
	const env = makeEnv({
		usage: { [CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: CUTOFF - 72 * 3600 * 1000 }) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 72 * 3600 * 1000, upload: 0, download: 0, connect: 8 }),
	]));
	const result = await run(env, fetchImpl);
	const settled = result.results.find(r => r.customerId === CUSTOMER_A);
	assert.equal(settled.status, 'settled');
	assert.equal(settled.addedBytes, 0);
	assert.equal(settled.usageSettledThrough, CUTOFF);
	assert.equal(usagePuts(env.KV), 1);
});

test('相同 cutoff 重复运行不重复累计', async () => {
	const env = makeEnv({
		usage: { [CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: CUTOFF - 12 * 3600 * 1000 }) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 100, download: 0, connect: 12 }),
	]));
	const first = await run(env, fetchImpl);
	assert.equal(first.settledCount, 1);
	const afterFirst = jsonParse(env.KV._store.get(USAGE_KEY + CUSTOMER_A));
	assert.equal(afterFirst.settledUsedBytes, 100);
	const second = await run(env, fetchImpl);
	assert.equal(second.settledCount, 0);
	const afterSecond = jsonParse(env.KV._store.get(USAGE_KEY + CUSTOMER_A));
	assert.equal(afterSecond.settledUsedBytes, 100, '重复运行不得重复累计');
});

// ---------------------------------------------------------------------------
// KV 压力与失败隔离
// ---------------------------------------------------------------------------

test('每个活跃客户最多一次 KV get，到期客户最多一次 put', async () => {
	const env = makeEnv({
		usage: {
			[CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: CUTOFF - 12 * 3600 * 1000 }),
			[CUSTOMER_B]: makeUsage(CUSTOMER_B, { usageSettledThrough: CUTOFF - 72 * 3600 * 1000 }),
		},
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 10, download: 10, connect: 12 }),
		bucketRow(CUSTOMER_B, { startMs: CUTOFF - 72 * 3600 * 1000, upload: 5, download: 5, connect: 2 }),
	]));
	const result = await run(env, fetchImpl);
	assert.equal(result.settledCount, 2);
	assert.equal(usageGets(env.KV), 2);
	assert.equal(usagePuts(env.KV), 2);
	assert.equal(fetchImpl.calls.length, 1, '单条统一 SQL');
});

test('未到期客户零 KV put', async () => {
	const env = makeEnv({
		usage: {
			[CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: CUTOFF - 12 * 3600 * 1000 }),
			[CUSTOMER_B]: makeUsage(CUSTOMER_B, { usageSettledThrough: CUTOFF - 12 * 3600 * 1000 }),
		},
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 10, download: 10, connect: 2 }),
		bucketRow(CUSTOMER_B, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 10, download: 10, connect: 7 }),
	]));
	const result = await run(env, fetchImpl);
	assert.equal(result.settledCount, 0);
	assert.equal(usagePuts(env.KV), 0);
});

test('SQL 失败时零 KV get 和零 KV put', async () => {
	const env = makeEnv({
		usage: { [CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: CUTOFF - 12 * 3600 * 1000 }) },
	});
	const fetchImpl = createFetch(() => jsonResponse(403, { success: false, errors: [{ code: 9109, message: 'authorization anomaly' }] }));
	const result = await run(env, fetchImpl);
	assert.equal(result.ok, false);
	assert.equal(usageGets(env.KV), 0);
	assert.equal(usagePuts(env.KV), 0);
});

test('单客户 get 失败不影响其他客户', async () => {
	const env = makeEnv({
		usage: {
			[CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: CUTOFF - 12 * 3600 * 1000 }),
			[CUSTOMER_B]: makeUsage(CUSTOMER_B, { usageSettledThrough: CUTOFF - 12 * 3600 * 1000 }),
		},
		hooks: { failGet: new Set([USAGE_KEY + CUSTOMER_A]) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 10, download: 10, connect: 12 }),
		bucketRow(CUSTOMER_B, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 10, download: 10, connect: 12 }),
	]));
	const result = await run(env, fetchImpl);
	assert.equal(result.failedCount, 1);
	assert.equal(result.settledCount, 1);
	assert.equal(usagePuts(env.KV), 1);
});

test('单客户 put 失败不影响其他客户，且下次可重试', async () => {
	const env = makeEnv({
		usage: {
			[CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: CUTOFF - 12 * 3600 * 1000 }),
			[CUSTOMER_B]: makeUsage(CUSTOMER_B, { usageSettledThrough: CUTOFF - 12 * 3600 * 1000 }),
		},
		hooks: { failPut: new Set([USAGE_KEY + CUSTOMER_A]) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 100, download: 0, connect: 12 }),
		bucketRow(CUSTOMER_B, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 10, download: 10, connect: 12 }),
	]));
	const first = await run(env, fetchImpl);
	assert.equal(first.failedCount, 1);
	assert.equal(first.settledCount, 1);
	assert.equal(jsonParse(env.KV._store.get(USAGE_KEY + CUSTOMER_A)).settledUsedBytes, 0, '失败客户水位保持原样');
	env.KV._hooks.failPut.clear();
	const second = await run(env, fetchImpl);
	assert.equal(second.settledCount, 1);
	assert.equal(jsonParse(env.KV._store.get(USAGE_KEY + CUSTOMER_A)).settledUsedBytes, 100);
});

test('无效 usage 记录安全跳过', async () => {
	const env = makeEnv({
		usage: {
			[CUSTOMER_A]: 'not-json',
			[CUSTOMER_B]: makeUsage(CUSTOMER_B, { usageSettledThrough: CUTOFF - 12 * 3600 * 1000 }),
		},
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 10, download: 10, connect: 12 }),
		bucketRow(CUSTOMER_B, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 10, download: 10, connect: 12 }),
	]));
	const result = await run(env, fetchImpl);
	assert.equal(result.skippedCount, 1);
	assert.equal(result.settledCount, 1);
});

test('非法 customerId 安全跳过', async () => {
	const env = makeEnv({
		usage: { [CUSTOMER_B]: makeUsage(CUSTOMER_B, { usageSettledThrough: CUTOFF - 12 * 3600 * 1000 }) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		['invalid-customer-id', indexFor(CUTOFF - 12 * 3600 * 1000), 10, 10, 12, 1000],
		bucketRow(CUSTOMER_B, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 10, download: 10, connect: 12 }),
	]));
	const result = await run(env, fetchImpl);
	assert.equal(result.customerCount, 1);
	assert.equal(result.settledCount, 1);
});

// ---------------------------------------------------------------------------
// 水位缺口
// ---------------------------------------------------------------------------

test('missing watermark 且 used=0 可安全初始化并结算', async () => {
	const env = makeEnv({
		usage: { [CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: 0, settledUsedBytes: 0 }) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 24 * 3600 * 1000, upload: 30, download: 30, connect: 12 }),
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 20, download: 20, connect: 12 }),
	]));
	const first = await run(env, fetchImpl);
	assert.equal(first.settledCount, 1);
	assert.equal(jsonParse(env.KV._store.get(USAGE_KEY + CUSTOMER_A)).settledUsedBytes, 100);
	const second = await run(env, fetchImpl);
	assert.equal(second.settledCount, 0);
	assert.equal(jsonParse(env.KV._store.get(USAGE_KEY + CUSTOMER_A)).settledUsedBytes, 100, '不得重复累计');
});

test('missing watermark 且 used>0 跳过', async () => {
	const env = makeEnv({
		usage: { [CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: 0, settledUsedBytes: 5 * GIB }) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 10, download: 10, connect: 12 }),
	]));
	const result = await run(env, fetchImpl);
	assert.equal(result.settledCount, 0);
	assert.equal(result.results[0].reason, 'missing_watermark_with_existing_usage');
	assert.equal(usagePuts(env.KV), 0);
});

test('watermark 早于 lookback 窗口时跳过', async () => {
	const env = makeEnv({
		usage: { [CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: frequencyBucketStartMs(WINDOW_START) }) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 10, download: 10, connect: 12 }),
	]));
	const result = await run(env, fetchImpl);
	assert.equal(result.results[0].reason, 'watermark_before_lookback');
	assert.equal(usagePuts(env.KV), 0);
});

test('watermark 已达到 cutoff 时不 put', async () => {
	const env = makeEnv({
		usage: { [CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: CUTOFF }) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 10, download: 10, connect: 12 }),
	]));
	const result = await run(env, fetchImpl);
	assert.equal(result.results[0].reason, 'already_settled');
	assert.equal(usagePuts(env.KV), 0);
});

test('非 12 小时边界水位不会造成部分桶重复累计（保守跳过）', async () => {
	const env = makeEnv({
		usage: { [CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: CUTOFF - 6 * 3600 * 1000 }) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 10, download: 10, connect: 12 }),
	]));
	const result = await run(env, fetchImpl);
	assert.equal(result.results[0].reason, 'invalid_watermark');
	assert.equal(usagePuts(env.KV), 0);
});

// ---------------------------------------------------------------------------
// 额度规则
// ---------------------------------------------------------------------------

test('累计后未达到额度时 quotaExceeded=false', async () => {
	const env = makeEnv({
		usage: { [CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: CUTOFF - 12 * 3600 * 1000, settledUsedBytes: 10 * GIB, quotaBytes: 100 * GIB }) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 1 * GIB, download: 1 * GIB, connect: 12 }),
	]));
	const result = await run(env, fetchImpl);
	assert.equal(result.results[0].quotaExceeded, false);
});

test('累计后达到额度时 quotaExceeded=true', async () => {
	const env = makeEnv({
		usage: { [CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: CUTOFF - 12 * 3600 * 1000, settledUsedBytes: 98 * GIB, quotaBytes: 100 * GIB }) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 1 * GIB, download: 1 * GIB, connect: 12 }),
	]));
	const result = await run(env, fetchImpl);
	assert.equal(result.results[0].quotaExceeded, true);
	assert.equal(jsonParse(env.KV._store.get(USAGE_KEY + CUSTOMER_A)).quotaExceeded, true);
});

test('unlimitedTraffic 不会 quotaExceeded', async () => {
	const env = makeEnv({
		usage: { [CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: CUTOFF - 12 * 3600 * 1000, unlimitedTraffic: true, quotaBytes: null, settledUsedBytes: 0 }) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 10 * GIB, download: 10 * GIB, connect: 12 }),
	]));
	const result = await run(env, fetchImpl);
	assert.equal(result.results[0].quotaExceeded, false);
});

test('结算不修改 enabled、不覆盖 disableReason、不自动启用停用客户', async () => {
	const env = makeEnv({
		usage: { [CUSTOMER_A]: makeUsage(CUSTOMER_A, { usageSettledThrough: CUTOFF - 12 * 3600 * 1000 }) },
		main: { [CUSTOMER_A]: makeCustomer(CUSTOMER_A, { enabled: false, disableReason: 'manual' }) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		bucketRow(CUSTOMER_A, { startMs: CUTOFF - 12 * 3600 * 1000, upload: 10, download: 10, connect: 12 }),
	]));
	const result = await run(env, fetchImpl);
	assert.equal(result.settledCount, 1);
	assert.ok(!env.KV._calls.puts.some(key => key.startsWith(CUSTOMER_KEY)), '不得写客户主记录');
	const storedMain = jsonParse(env.KV._store.get(CUSTOMER_KEY + CUSTOMER_A));
	assert.equal(storedMain.enabled, false, '不得自动重新启用');
	assert.equal(storedMain.disableReason, 'manual', '不得覆盖人工 disableReason');
});
