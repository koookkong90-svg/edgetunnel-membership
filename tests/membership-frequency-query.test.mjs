import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	frequencyBucketStartMs,
	getLatestClosedBucketEnd,
	parseFrequencySettlementPolicy,
	buildFrequencyBucketQuery,
	parseFrequencyBucketRows,
	classifyCustomerFrequency,
	aggregateCustomerFrequencyWindow,
} from '../membership-settlement.js';

const DATASET = 'membership_usage_test_v1';
const POLICY_VERSION = 'usage-v1';
const BUCKET_MS = 12 * 3600 * 1000;
const CUSTOMER_A = 'cus_aaaaaaaaaaaaaaaaaaaa';
const CUSTOMER_B = 'cus_bbbbbbbbbbbbbbbbbbbb';

function validPolicy(overrides = {}) {
	return {
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
		...overrides,
	};
}

function policy(overrides = {}) {
	const result = parseFrequencySettlementPolicy(JSON.stringify(validPolicy(overrides)));
	assert.equal(result.ok, true, `policy should parse: ${result.reason || ''}`);
	return result.policy;
}

function bucket(customerId, overrides = {}) {
	return {
		customerId,
		bucketStartMs: 0,
		bucketEndMs: BUCKET_MS,
		uploadBytes: 0,
		downloadBytes: 0,
		connectCount: 0,
		latestEventMs: 0,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// 12 小时桶边界
// ---------------------------------------------------------------------------

test('Asia/Shanghai 00:00–12:00 桶边界', () => {
	// 2026-08-23 06:00 CST = 2026-08-22 22:00 UTC，所在桶起点为 2026-08-23 00:00 CST。
	const start = frequencyBucketStartMs(Date.UTC(2026, 7, 22, 22, 0, 0));
	assert.equal(start, Date.UTC(2026, 7, 22, 16, 0, 0));
	assert.equal(start + BUCKET_MS, Date.UTC(2026, 7, 23, 4, 0, 0));
});

test('Asia/Shanghai 12:00–次日00:00 桶边界', () => {
	// 2026-08-23 18:00 CST = 2026-08-23 10:00 UTC，所在桶起点为 2026-08-23 12:00 CST。
	const start = frequencyBucketStartMs(Date.UTC(2026, 7, 23, 10, 0, 0));
	assert.equal(start, Date.UTC(2026, 7, 23, 4, 0, 0));
	assert.equal(start + BUCKET_MS, Date.UTC(2026, 7, 23, 16, 0, 0));
});

test('跨日期时桶边界正确', () => {
	const before = frequencyBucketStartMs(Date.UTC(2026, 7, 23, 3, 59, 59)); // 11:59:59 CST
	const after = frequencyBucketStartMs(Date.UTC(2026, 7, 23, 4, 0, 0)); // 12:00:00 CST
	assert.equal(before, Date.UTC(2026, 7, 22, 16, 0, 0));
	assert.equal(after, Date.UTC(2026, 7, 23, 4, 0, 0));
	assert.equal(after - before, BUCKET_MS);
});

// ---------------------------------------------------------------------------
// 关闭桶与延迟
// ---------------------------------------------------------------------------

test('正在进行的桶不被纳入查询窗口', () => {
	// 2026-08-23 15:00 CST：当前桶 12:00–00:00 尚未结束。
	const now = Date.UTC(2026, 7, 23, 7, 0, 0);
	assert.equal(getLatestClosedBucketEnd(now, 0), Date.UTC(2026, 7, 23, 4, 0, 0));
});

test('closedBucketDelayHours 排除刚关闭的桶', () => {
	// 2026-08-23 13:00 CST：12:00 桶刚关闭 1 小时，小于 2 小时延迟。
	const now = Date.UTC(2026, 7, 23, 5, 0, 0);
	assert.equal(getLatestClosedBucketEnd(now, 2), Date.UTC(2026, 7, 22, 16, 0, 0));
	assert.equal(getLatestClosedBucketEnd(now, 0), Date.UTC(2026, 7, 23, 4, 0, 0));
});

// ---------------------------------------------------------------------------
// SQL 查询
// ---------------------------------------------------------------------------

test('SQL 只生成一条统一 GROUP BY 查询（不按客户拆分）', () => {
	const query = buildFrequencyBucketQuery({ dataset: DATASET, policyVersion: POLICY_VERSION }, 0, BUCKET_MS * 2);
	assert.equal(query.split('SELECT').length, 2, '只能有一个 SELECT');
	assert.match(query, /GROUP BY index1, bucketIndex/);
	assert.doesNotMatch(query, /GROUP BY index1\b(?!, bucketIndex)/);
});

test('bucketIndex 使用 Analytics Engine 兼容的 intDiv(toUInt32(timestamp)) 表达式', () => {
	const query = buildFrequencyBucketQuery({ dataset: DATASET, policyVersion: POLICY_VERSION }, 0, BUCKET_MS * 2);
	assert.match(query, /intDiv\(toUInt32\(timestamp\) - 57600, 43200\) AS bucketIndex/);
	assert.doesNotMatch(query, /toInt64\(/);
	assert.doesNotMatch(query, /toUnixTimestamp\(/);
	assert.doesNotMatch(query, /floor\(/);
});

test('Analytics 采样补偿公式正确（上传/下载/connect）', () => {
	const query = buildFrequencyBucketQuery({ dataset: DATASET, policyVersion: POLICY_VERSION }, 0, BUCKET_MS * 2);
	assert.match(query, /SUM\(_sample_interval \* double1 \* double3\) AS uploadBytes/);
	assert.match(query, /SUM\(_sample_interval \* double2 \* double3\) AS downloadBytes/);
	assert.match(query, /sumIf\(_sample_interval \* double4, blob3 = 'connect'\) AS connectCount/);
	assert.doesNotMatch(query, /SUM\(\s*IF\(/);
	assert.doesNotMatch(query, /double4,\s*0/);
});

test('block/interval/close 不计入连接次数（SQL 仅统计 connect）', () => {
	const query = buildFrequencyBucketQuery({ dataset: DATASET, policyVersion: POLICY_VERSION }, 0, BUCKET_MS * 2);
	assert.match(query, /blob3 = 'connect'/);
	assert.doesNotMatch(query, /blob3 = 'block'/);
	assert.doesNotMatch(query, /blob3 = 'interval'/);
	assert.doesNotMatch(query, /blob3 = 'close'/);
	assert.match(query, /WHERE blob1 = 'usage-v1'/);
	assert.match(query, /AND blob2 = 'vless-ws'/);
});

test('SQL 不包含 UUID、Token、客户名称或目标地址', () => {
	const query = buildFrequencyBucketQuery({ dataset: DATASET, policyVersion: POLICY_VERSION }, 0, BUCKET_MS * 2);
	assert.ok(!query.includes('uuid'), '不得包含 uuid');
	assert.ok(!query.toLowerCase().includes('token'), '不得包含 token');
	assert.ok(!query.toLowerCase().includes('name'), '不得包含 name');
	assert.ok(!query.toLowerCase().includes('example.com'), '不得包含目标域名');
	assert.ok(!query.toLowerCase().includes('membership:'), '不得包含 KV 键');
});

// ---------------------------------------------------------------------------
// 行解析与 JS 聚合
// ---------------------------------------------------------------------------

test('多个客户能在同一 SQL 结果中解析', () => {
	const indexFor = utcMs => Math.floor((utcMs - 16 * 3600 * 1000) / BUCKET_MS);
	const bucketA = indexFor(Date.UTC(2026, 7, 22, 16, 0, 0)); // 2026-08-23 00:00 CST
	const rows = [
		{ customerId: CUSTOMER_A, bucketIndex: bucketA, uploadBytes: 10, downloadBytes: 20, connectCount: 2, latestEventTs: 1000 },
		{ customerId: CUSTOMER_B, bucketIndex: bucketA, uploadBytes: 30, downloadBytes: 40, connectCount: 1, latestEventTs: 2000 },
		{ customerId: CUSTOMER_A, bucketIndex: bucketA + 1, uploadBytes: 5, downloadBytes: 5, connectCount: 3, latestEventTs: 3000 },
	];
	const buckets = parseFrequencyBucketRows(rows);
	assert.equal(buckets.length, 3);
	const agg = aggregateCustomerFrequencyWindow(buckets, policy(), Date.UTC(2026, 7, 23, 5, 0, 0));
	assert.equal(agg.length, 2);
	const customerA = agg.find(entry => entry.customerId === CUSTOMER_A);
	assert.equal(customerA.buckets.length, 2);
	assert.equal(customerA.connectsInWindow, 5);
	assert.equal(customerA.buckets[0].bucketStartMs, bucketA * BUCKET_MS + 16 * 3600 * 1000);
	assert.equal(customerA.buckets[0].bucketEndMs, (bucketA + 1) * BUCKET_MS + 16 * 3600 * 1000);
	assert.equal(customerA.latestEventMs, 3000 * 1000);
});

test('connect 事件计入连接次数；零字节不影响流量总量', () => {
	const parsed = policy();
	const agg = aggregateCustomerFrequencyWindow([
		bucket(CUSTOMER_A, { uploadBytes: 0, downloadBytes: 0, connectCount: 9, latestEventMs: 1000 }),
	], parsed, 1000 + 24 * 3600 * 1000);
	assert.equal(agg[0].connectsInWindow, 9);
	assert.equal(agg[0].buckets[0].uploadBytes, 0);
	assert.equal(agg[0].buckets[0].downloadBytes, 0);
});

test('最近 24 小时连接数聚合正确（窗口外桶保留但不计连接）', () => {
	const now = Date.UTC(2026, 7, 23, 5, 0, 0);
	const parsed = policy();
	const agg = aggregateCustomerFrequencyWindow([
		bucket(CUSTOMER_A, { bucketStartMs: now - 42 * 3600 * 1000, bucketEndMs: now - 30 * 3600 * 1000, connectCount: 3, latestEventMs: now - 31 * 3600 * 1000 }),
		bucket(CUSTOMER_A, { bucketStartMs: now - 18 * 3600 * 1000, bucketEndMs: now - 6 * 3600 * 1000, connectCount: 5, latestEventMs: now - 7 * 3600 * 1000 }),
	], parsed, now);
	assert.equal(agg[0].connectsInWindow, 5);
	assert.equal(agg[0].buckets.length, 2, '窗口外桶仍保留在 buckets 中');
	assert.equal(agg[0].latestEventMs, now - 7 * 3600 * 1000);
});

// ---------------------------------------------------------------------------
// 频率分类
// ---------------------------------------------------------------------------

test('高频分类正确（仅影响结算周期）', () => {
	const parsed = policy();
	const result = classifyCustomerFrequency(12, parsed);
	assert.equal(result.tier, 'high');
	assert.equal(result.settlementIntervalHours, 12);
});

test('中频分类正确', () => {
	const parsed = policy();
	const result = classifyCustomerFrequency(7, parsed);
	assert.equal(result.tier, 'medium');
	assert.equal(result.settlementIntervalHours, 24);
});

test('低频分类正确', () => {
	const parsed = policy();
	const result = classifyCustomerFrequency(2, parsed);
	assert.equal(result.tier, 'low');
	assert.equal(result.settlementIntervalHours, 72);
});

// ---------------------------------------------------------------------------
// 策略校验
// ---------------------------------------------------------------------------

test('highFrequencyThreshold <= mediumFrequencyThreshold 被拒绝', () => {
	assert.equal(parseFrequencySettlementPolicy(JSON.stringify(validPolicy({ highFrequencyThreshold: 5, mediumFrequencyThreshold: 5 }))).ok, false);
	assert.equal(parseFrequencySettlementPolicy(JSON.stringify(validPolicy({ highFrequencyThreshold: 3, mediumFrequencyThreshold: 5 }))).ok, false);
});

test('非 12 小时整数倍的结算周期被拒绝', () => {
	assert.equal(parseFrequencySettlementPolicy(JSON.stringify(validPolicy({ highSettlementHours: 18 }))).ok, false);
	assert.equal(parseFrequencySettlementPolicy(JSON.stringify(validPolicy({ mediumSettlementHours: 30 }))).ok, false);
	assert.equal(parseFrequencySettlementPolicy(JSON.stringify(validPolicy({ lowSettlementHours: 66 }))).ok, false);
});

test('bucketHours 非 12 被拒绝', () => {
	assert.equal(parseFrequencySettlementPolicy(JSON.stringify(validPolicy({ bucketHours: 24 }))).ok, false);
});

test('lookbackHours 不足被拒绝', () => {
	assert.equal(parseFrequencySettlementPolicy(JSON.stringify(validPolicy({ lookbackHours: 60 }))).ok, false);
});

test('非法 JSON 被拒绝', () => {
	assert.equal(parseFrequencySettlementPolicy('{not-json').ok, false);
	assert.equal(parseFrequencySettlementPolicy('').ok, false);
});

test('缺少正式连接阈值时不能静默启用', () => {
	const stripped = validPolicy();
	delete stripped.highFrequencyThreshold;
	delete stripped.mediumFrequencyThreshold;
	const result = parseFrequencySettlementPolicy(JSON.stringify(stripped));
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'missing_connect_thresholds');
});

// ---------------------------------------------------------------------------
// 纯函数边界
// ---------------------------------------------------------------------------

test('本阶段纯函数不调用 KV（无 KV 读写路径）', () => {
	const parsed = policy();
	const buckets = parseFrequencyBucketRows([
		{ customerId: CUSTOMER_A, bucketIndex: 100, uploadBytes: 1, downloadBytes: 2, connectCount: 3, latestEventTs: 100 },
	]);
	const agg = aggregateCustomerFrequencyWindow(buckets, parsed, 1000 + 24 * 3600 * 1000);
	assert.equal(agg[0].buckets[0].uploadBytes, 1);
	assert.equal(agg[0].buckets[0].downloadBytes, 2);
});
