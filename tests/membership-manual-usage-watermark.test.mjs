import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto as realWebcrypto } from 'node:crypto';
import {
	getCurrentFrequencyBucketEnd,
	runFrequencyLayeredSettlement,
} from '../membership-settlement.js';

// ---------------------------------------------------------------------------
// 全局桩（必须在 import _worker.js 之前安装）
// ---------------------------------------------------------------------------

const mockCrypto = {
	getRandomValues(array) {
		return realWebcrypto.getRandomValues(array);
	},
	subtle: {
		async digest(algorithm, data) {
			if (String(algorithm).toUpperCase() === 'MD5') {
				return new Uint8Array(createHash('md5').update(Buffer.from(data)).digest());
			}
			return realWebcrypto.subtle.digest(algorithm, data);
		},
		importKey: (...args) => realWebcrypto.subtle.importKey(...args),
		encrypt: (...args) => realWebcrypto.subtle.encrypt(...args),
		decrypt: (...args) => realWebcrypto.subtle.decrypt(...args),
		sign: (...args) => realWebcrypto.subtle.sign(...args),
		verify: (...args) => realWebcrypto.subtle.verify(...args),
	},
};
Object.defineProperty(globalThis, 'crypto', { value: mockCrypto, configurable: true, writable: true });

class MockResponse {
	constructor(body, init = {}) {
		this.body = body;
		this.status = init.status ?? 200;
		this.statusText = init.statusText || '';
		this.headers = new Headers(init.headers || {});
		this.webSocket = init.webSocket;
		this.bodyUsed = false;
	}

	text() {
		return Promise.resolve(String(this.body ?? ''));
	}

	json() {
		return Promise.resolve(JSON.parse(String(this.body ?? '')));
	}
}
Object.defineProperty(globalThis, 'Response', { value: MockResponse, configurable: true, writable: true });

const worker = (await import('../_worker.js')).default;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const CUSTOMER_ID = 'cus_test1234567890abcd';
const CUSTOMER_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const USAGE_KEY = `membership:usage:${CUSTOMER_ID}`;
const CUSTOMER_KEY = `membership:customer:${CUSTOMER_ID}`;
const ORIGIN = 'https://v20251104-membership-test.koookkong90.workers.dev';
const UA = 'Karing/1.0.0';
const GIB = 1024 ** 3;

function makeUsage(overrides = {}) {
	return {
		schemaVersion: 4,
		kind: 'membership-usage',
		customerId: CUSTOMER_ID,
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

function makeCustomer(overrides = {}) {
	return {
		schemaVersion: 4,
		kind: 'membership-customer',
		customerId: CUSTOMER_ID,
		name: 'Test User',
		remark: 'keep-me',
		uuid: CUSTOMER_UUID,
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

function makeKv({ usage = makeUsage(), customer = makeCustomer() } = {}) {
	const store = new Map([
		[USAGE_KEY, JSON.stringify(usage)],
		[CUSTOMER_KEY, JSON.stringify(customer)],
	]);
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
	kv._store = store;
	kv._calls = calls;
	return kv;
}

function makeEnv({ kv }) {
	return {
		ADMIN: 'test-admin-password',
		KEY: 'test-encryption-key',
		MEMBERSHIP_MODE: 'hybrid',
		KV: kv,
		MEMBERSHIP_USAGE_ACCOUNT_ID: 'a'.repeat(32),
		MEMBERSHIP_USAGE_API_TOKEN: 'test-token',
		MEMBERSHIP_USAGE_DATASET: 'membership_usage_test_v1',
		MEMBERSHIP_USAGE_SETTLEMENT_ENABLED: 'true',
		MEMBERSHIP_USAGE_SETTLEMENT_TIMEZONE: 'Asia/Shanghai',
		USAGE_SETTLEMENT_POLICY_JSON: JSON.stringify({
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
		}),
	};
}

async function md5Hex(text) {
	const digest = await crypto.subtle.digest('MD5', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function adminCookie() {
	const first = await md5Hex(UA + 'test-encryption-key' + 'test-admin-password');
	const second = await md5Hex(first.slice(7, 27));
	return second;
}

function jsonBodyStream(object) {
	const bytes = new TextEncoder().encode(JSON.stringify(object));
	let offset = 0;
	return {
		getReader() {
			return {
				async read() {
					if (offset >= bytes.length) return { done: true, value: undefined };
					const chunk = bytes.slice(offset, Math.min(offset + 64, bytes.length));
					offset += chunk.length;
					return { done: false, value: chunk };
				},
				cancel() {
					offset = bytes.length;
				},
				releaseLock() {},
			};
		},
	};
}

async function fireAdminMutation(kv, path, body) {
	const cookie = await adminCookie();
	const request = {
		url: `${ORIGIN}/admin/api/customers/${CUSTOMER_ID}/${path}`,
		method: 'POST',
		headers: {
			get(name) {
				const map = {
					'user-agent': UA,
					'content-type': 'application/json',
					'content-length': String(JSON.stringify(body).length),
					origin: ORIGIN,
					'x-admin-request': '1',
					cookie: `auth=${cookie}`,
				};
				return map[String(name).toLowerCase()] ?? null;
			},
		},
		body: jsonBodyStream(body),
		cf: { colo: 'HKG', asn: 13335 },
	};
	return worker.fetch(request, makeEnv({ kv }), { waitUntil() {} });
}

function jsonParse(value) {
	return JSON.parse(value);
}

// ---------------------------------------------------------------------------
// getCurrentFrequencyBucketEnd 纯函数
// ---------------------------------------------------------------------------

test('北京时间 09:00 时当前桶结束为当天 12:00', () => {
	// 2026-08-23 09:00 CST = 01:00 UTC
	const end = getCurrentFrequencyBucketEnd(Date.UTC(2026, 7, 23, 1, 0, 0));
	assert.equal(end, Date.UTC(2026, 7, 23, 4, 0, 0)); // 12:00 CST
});

test('北京时间 15:00 时当前桶结束为次日 00:00', () => {
	// 2026-08-23 15:00 CST = 07:00 UTC
	const end = getCurrentFrequencyBucketEnd(Date.UTC(2026, 7, 23, 7, 0, 0));
	assert.equal(end, Date.UTC(2026, 7, 23, 16, 0, 0)); // 次日 00:00 CST
});

// ---------------------------------------------------------------------------
// 人工清空与校正推进水位
// ---------------------------------------------------------------------------

test('清空已用流量后 usageSettledThrough 推进到当前桶结束', async () => {
	const kv = makeKv({ usage: makeUsage({ settledUsedBytes: 5 * GIB }) });
	const response = await fireAdminMutation(kv, 'reset-usage', { confirm: true, expectedRevision: 1 });
	assert.equal(response.status, 200);
	const usage = jsonParse(kv._store.get(USAGE_KEY));
	assert.equal(usage.settledUsedBytes, 0);
	assert.equal(usage.usageSettledThrough, getCurrentFrequencyBucketEnd(Date.now()));
});

test('校正已用流量后 usageSettledThrough 推进到当前桶结束', async () => {
	const kv = makeKv({ usage: makeUsage({ settledUsedBytes: 3 * GIB }) });
	const response = await fireAdminMutation(kv, 'set-used-traffic', { usedGiB: 2, expectedUsageRevision: 1 });
	assert.equal(response.status, 200);
	const usage = jsonParse(kv._store.get(USAGE_KEY));
	assert.equal(usage.settledUsedBytes, 2 * GIB);
	assert.equal(usage.usageSettledThrough, getCurrentFrequencyBucketEnd(Date.now()));
});

test('清空后旧当前桶数据不会再次累计', async () => {
	const kv = makeKv({ usage: makeUsage({ settledUsedBytes: 5 * GIB }) });
	await fireAdminMutation(kv, 'reset-usage', { confirm: true, expectedRevision: 1 });
	const watermark = jsonParse(kv._store.get(USAGE_KEY)).usageSettledThrough;
	// 构造一个结束时间早于/等于人工水位的旧桶。
	const fetchImpl = async () => ({
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
				data: [[CUSTOMER_ID, Math.floor((watermark - 12 * 3600 * 1000 - 16 * 3600 * 1000) / (12 * 3600 * 1000)), 999 * GIB, 999 * GIB, 12, 1000]],
				rows: 1,
			});
		},
	});
	const result = await runFrequencyLayeredSettlement({ env: makeEnv({ kv }), fetchImpl, nowMs: Date.now() });
	assert.equal(result.ok, true);
	assert.equal(result.addedBytes, 0, '旧桶不得再次累计');
	assert.equal(jsonParse(kv._store.get(USAGE_KEY)).settledUsedBytes, 0);
});

test('校正后旧当前桶数据不会再次累计', async () => {
	const kv = makeKv({ usage: makeUsage({ settledUsedBytes: 3 * GIB }) });
	await fireAdminMutation(kv, 'set-used-traffic', { usedGiB: 2, expectedUsageRevision: 1 });
	const watermark = jsonParse(kv._store.get(USAGE_KEY)).usageSettledThrough;
	const fetchImpl = async () => ({
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
				data: [[CUSTOMER_ID, Math.floor((watermark - 12 * 3600 * 1000 - 16 * 3600 * 1000) / (12 * 3600 * 1000)), 999 * GIB, 0, 12, 1000]],
				rows: 1,
			});
		},
	});
	const result = await runFrequencyLayeredSettlement({ env: makeEnv({ kv }), fetchImpl, nowMs: Date.now() });
	assert.equal(result.ok, true);
	assert.equal(result.addedBytes, 0, '旧桶不得再次累计');
	assert.equal(jsonParse(kv._store.get(USAGE_KEY)).settledUsedBytes, 2 * GIB);
});

test('人工操作不改变 enabled 且不自动重新启用客户', async () => {
	const kv = makeKv({
		usage: makeUsage({ settledUsedBytes: 1 * GIB }),
		customer: makeCustomer({ enabled: false, disableReason: 'manual' }),
	});
	const response = await fireAdminMutation(kv, 'reset-usage', { confirm: true, expectedRevision: 1 });
	assert.equal(response.status, 200);
	const customer = jsonParse(kv._store.get(CUSTOMER_KEY));
	assert.equal(customer.enabled, false, '不得自动重新启用');
	assert.equal(customer.disableReason, 'manual');
});

test('人工操作保留其他字段', async () => {
	const kv = makeKv({ usage: makeUsage({ settledUsedBytes: 2 * GIB, quotaBytes: 50 * GIB }) });
	await fireAdminMutation(kv, 'set-used-traffic', { usedGiB: 4, expectedUsageRevision: 1 });
	const customer = jsonParse(kv._store.get(CUSTOMER_KEY));
	assert.equal(customer.name, 'Test User');
	assert.equal(customer.remark, 'keep-me');
	assert.equal(customer.uuid, CUSTOMER_UUID);
	assert.equal(customer.enabled, true);
	const usage = jsonParse(kv._store.get(USAGE_KEY));
	assert.equal(usage.quotaBytes, 50 * GIB);
	assert.equal(usage.settledUsedBytes, 4 * GIB);
	assert.equal(usage.revision, 2);
});
