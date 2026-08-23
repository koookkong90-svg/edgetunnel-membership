import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	getMembershipSettlementConfig,
	validateSettlementConfig,
	dayStartUtcMs,
	dayEndUtcMs,
	localDayKey,
	planSettlementDays,
	buildMembershipUsageDayQuery,
	parseSqlJsonResponse,
	extractUsageAggregate,
	parseDayRow,
	parseUsageRecord,
	computeMembershipUsageSettlement,
	runMembershipUsageSettlement,
} from '../membership-settlement.js';

const CUSTOMER_KEY = 'membership:customer:';
const USAGE_KEY = 'membership:usage:';
const CURSOR_KEY = 'settlement:global:lastCompletedDay';

const ACCOUNT_ID = 'a'.repeat(32);
const DATASET = 'membership_usage_test_v1';
const TZ = 'Asia/Shanghai';

// 2026-08-22 11:00 Asia/Shanghai (03:00 UTC).
const NOW = Date.UTC(2026, 7, 22, 3, 0, 0);
const DAY_21_START = Date.UTC(2026, 7, 20, 16, 0, 0); // 2026-08-21 00:00 +08
const DAY_21_END = Date.UTC(2026, 7, 21, 16, 0, 0); // 2026-08-22 00:00 +08

function makeBase(customerId, overrides = {}) {
	return {
		schemaVersion: 4,
		kind: 'membership-customer',
		customerId,
		name: 'Test User',
		remark: '',
		uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
		tokenHash: '0'.repeat(64),
		tokenPreview: '鈥⑩€⑩€⑩€bcd',
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

function makeUsage(customerId, overrides = {}) {
	return {
		schemaVersion: 4,
		kind: 'membership-usage',
		customerId,
		quotaBytes: 100 * 1024 ** 3,
		settledUsedBytes: 0,
		quotaExceeded: false,
		usageUpdatedAt: 0,
		usageSettledThrough: 0,
		unlimitedTraffic: false,
		revision: 1,
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

function jsonResponse(status, payload) {
	return { status, ok: status >= 200 && status < 300, async text() { return JSON.stringify(payload); } };
}

function groupedRows(rows) {
	return jsonResponse(200, groupedPayload(rows));
}

function groupedPayload(rows) {
	return {
		meta: [
			{ name: 'customerId', type: 'String' },
			{ name: 'uploadBytes', type: 'Float64' },
			{ name: 'downloadBytes', type: 'Float64' },
			{ name: 'pointCount', type: 'Float64' },
			{ name: 'rowCount', type: 'UInt64' },
		],
		data: rows,
		rows: rows.length,
	};
}

function sql403() {
	return jsonResponse(403, { success: false, errors: [{ code: 9109, message: 'authorization anomaly' }] });
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

function parseQueryRequest(call) {
	assert.equal(call.init.method, 'POST');
	assert.ok(call.url.includes(`/accounts/${ACCOUNT_ID}/analytics_engine/sql`), `unexpected URL ${call.url}`);
	assert.equal(call.init.headers.Authorization, 'Bearer test-token');
	const body = String(call.init.body);
	return {
		body,
		fromSec: Number(body.match(/timestamp >= toDateTime\((\d+)\)/)?.[1]),
		toSec: Number(body.match(/timestamp < toDateTime\((\d+)\)/)?.[1]),
	};
}

function makeEnv({ usage = {}, cursor = undefined, settings = {}, hooks = {} } = {}) {
	const initial = {};
	for (const [id, value] of Object.entries(usage)) {
		initial[USAGE_KEY + id] = typeof value === 'string' ? value : JSON.stringify(value);
	}
	if (cursor !== undefined) initial[CURSOR_KEY] = cursor;
	const kv = createKv(initial);
	Object.assign(kv._hooks, hooks);
	return {
		KV: kv,
		MEMBERSHIP_USAGE_ACCOUNT_ID: ACCOUNT_ID,
		MEMBERSHIP_USAGE_API_TOKEN: 'test-token',
		MEMBERSHIP_USAGE_DATASET: DATASET,
		MEMBERSHIP_USAGE_SETTLEMENT_ENABLED: 'true',
		MEMBERSHIP_USAGE_SETTLEMENT_TIMEZONE: TZ,
		...settings,
	};
}

async function run(env, fetchImpl, nowMs = NOW) {
	return runMembershipUsageSettlement({ env, fetchImpl, nowMs });
}

function jsonParse(value) {
	return JSON.parse(value);
}

function countsFor(kv, prefix) {
	return {
		gets: kv._calls.gets.filter(key => key.startsWith(prefix)).length,
		puts: kv._calls.puts.filter(key => key.startsWith(prefix)).length,
	};
}

// ---------------------------------------------------------------- day math

test('Asia/Shanghai day boundaries are UTC+8 and half-open', () => {
	assert.equal(dayStartUtcMs('2026-08-21', TZ), DAY_21_START);
	assert.equal(dayEndUtcMs('2026-08-21', TZ), DAY_21_END);
	assert.equal(dayEndUtcMs('2026-08-21', TZ), dayStartUtcMs('2026-08-22', TZ), 'consecutive days must be adjacent');
});

test('DST zones resolve day boundaries correctly', () => {
	// America/New_York: DST starts 2026-03-08 02:00 -> midnight is EST (UTC-5).
	assert.equal(dayStartUtcMs('2026-03-08', 'America/New_York'), Date.UTC(2026, 2, 8, 5, 0, 0));
	// DST ends 2026-11-01 02:00 -> midnight is EDT (UTC-4).
	assert.equal(dayStartUtcMs('2026-11-01', 'America/New_York'), Date.UTC(2026, 10, 1, 4, 0, 0));
	assert.equal(dayEndUtcMs('2026-03-08', 'America/New_York'), dayStartUtcMs('2026-03-09', 'America/New_York'));
	assert.equal(dayEndUtcMs('2026-11-01', 'America/New_York'), dayStartUtcMs('2026-11-02', 'America/New_York'));
});

test('localDayKey follows the configured timezone boundary', () => {
	assert.equal(localDayKey(Date.UTC(2026, 7, 21, 15, 59, 59), TZ), '2026-08-21');
	assert.equal(localDayKey(Date.UTC(2026, 7, 21, 16, 0, 0), TZ), '2026-08-22');
	assert.equal(localDayKey(Date.UTC(2026, 7, 21, 23, 59, 59), TZ), '2026-08-22');
	assert.equal(localDayKey(Date.UTC(2026, 7, 22, 0, 0, 0), TZ), '2026-08-22');
});

test('planSettlementDays handles first run, catch-up and window limits', () => {
	const today = '2026-08-22';
	assert.deepEqual(planSettlementDays(null, today, 3), {
		days: ['2026-08-19', '2026-08-20', '2026-08-21'],
		skippedDays: [],
	});
	assert.deepEqual(planSettlementDays('', today, 3), {
		days: ['2026-08-19', '2026-08-20', '2026-08-21'],
		skippedDays: [],
	});
	assert.deepEqual(planSettlementDays('2026-08-21', today, 3), { days: [], skippedDays: [] });
	assert.deepEqual(planSettlementDays('2026-08-20', today, 3), { days: ['2026-08-21'], skippedDays: [] });
	assert.deepEqual(planSettlementDays('2026-08-22', today, 3), { days: [], skippedDays: [] });
	// Cursor far behind: only the last 3 completed days are settled, older days reported.
	const behind = planSettlementDays('2026-08-10', today, 3);
	assert.deepEqual(behind.days, ['2026-08-19', '2026-08-20', '2026-08-21']);
	assert.deepEqual(behind.skippedDays, ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17', '2026-08-18']);
	assert.throws(() => planSettlementDays('garbage', today, 3), error => error.code === 'invalid_cursor');
});

// ---------------------------------------------------------------- query

test('buildMembershipUsageDayQuery groups by index1 and keeps sampling compensation', () => {
	const query = buildMembershipUsageDayQuery({ dataset: DATASET }, '2026-08-21', TZ);
	assert.ok(query.includes('GROUP BY index1'));
	assert.ok(query.includes('index1 AS customerId'));
	assert.ok(query.includes('SUM(_sample_interval * double3 * double1) AS uploadBytes'));
	assert.ok(query.includes('SUM(_sample_interval * double3 * double2) AS downloadBytes'));
	assert.ok(query.includes(`timestamp >= toDateTime(${DAY_21_START / 1000})`));
	assert.ok(query.includes(`timestamp < toDateTime(${DAY_21_END / 1000})`));
	assert.ok(!query.includes(`index1 = 'cus_`), 'must not filter per customer');
	assert.throws(() => buildMembershipUsageDayQuery({ dataset: 'bad dataset' }, '2026-08-21', TZ), error => error.code === 'invalid_dataset');
});

test('parseDayRow validates customer id and aggregate values', () => {
	assert.deepEqual(parseDayRow({ customerId: 'cus_AbCdEfGhIjKlMnOpQr1234', uploadBytes: 100, downloadBytes: 200, pointCount: 3, rowCount: 1 }), {
		customerId: 'cus_AbCdEfGhIjKlMnOpQr1234',
		uploadBytes: 100,
		downloadBytes: 200,
		pointCount: 3,
		rowCount: 1,
	});
	assert.throws(() => parseDayRow({ customerId: 'not-a-customer', uploadBytes: 1, downloadBytes: 0, pointCount: 0, rowCount: 0 }), error => error.code === 'sql_data_invalid');
	assert.throws(() => parseDayRow({ customerId: 'cus_AbCdEfGhIjKlMnOpQr1234', uploadBytes: -1, downloadBytes: 0, pointCount: 0, rowCount: 0 }), error => error.code === 'sql_data_invalid');
	assert.throws(() => parseDayRow(null), error => error.code === 'sql_data_invalid');
});

test('parseSqlJsonResponse handles grouped array rows', () => {
	const rows = parseSqlJsonResponse(JSON.stringify(groupedPayload([
		['cus_AbCdEfGhIjKlMnOpQr1234', 100, 200, 3, 1],
		['cus_AbCdEfGhIjKlMnOpQr5678', 50, 60, 2, 1],
	])));
	assert.equal(rows.length, 2);
	assert.equal(rows[0].customerId, 'cus_AbCdEfGhIjKlMnOpQr1234');
	assert.equal(rows[0].uploadBytes, 100);
	assert.equal(rows[1].downloadBytes, 60);
});

// ---------------------------------------------------------------- records

test('usage record parser stays strict and compatible', () => {
	const usage = makeUsage('cus_AbCdEfGhIjKlMnOpQr1234', { usageSettledThrough: DAY_21_START });
	assert.deepEqual(parseUsageRecord(JSON.stringify(usage)), usage);
	assert.throws(() => parseUsageRecord('{bad json'), error => error.code === 'invalid_usage_record');
	assert.throws(() => parseUsageRecord(JSON.stringify({ ...usage, extra: 1 })), error => error.code === 'invalid_usage_record');
});

test('computeMembershipUsageSettlement applies one day and sets the day boundary marker', () => {
	const usage = makeUsage('cus_AbCdEfGhIjKlMnOpQr1234', { settledUsedBytes: 1000, usageSettledThrough: DAY_21_START - 86_400_000 });
	const updated = computeMembershipUsageSettlement(usage, { uploadBytes: 400, downloadBytes: 200, pointCount: 2, rowCount: 2 }, DAY_21_START, NOW);
	assert.equal(updated.settledUsedBytes, 1600);
	assert.equal(updated.usageSettledThrough, DAY_21_START);
	assert.equal(updated.usageUpdatedAt, NOW);
	assert.equal(updated.revision, 2);
	assert.equal(updated.quotaExceeded, false);
	assert.throws(() => computeMembershipUsageSettlement(
		makeUsage('cus_AbCdEfGhIjKlMnOpQr1234', { usageSettledThrough: DAY_21_START }),
		{ uploadBytes: 1, downloadBytes: 0, pointCount: 0, rowCount: 0 },
		DAY_21_START,
		NOW,
	), error => error.code === 'window_not_advancing');
});

// ---------------------------------------------------------------- happy path

test('single day settlement: one SQL query, one get + one put per customer', async () => {
	const a = 'cus_AbCdEfGhIjKlMnOpQr1234';
	const b = 'cus_AbCdEfGhIjKlMnOpQr5678';
	const env = makeEnv({
		usage: {
			[a]: makeUsage(a),
			[b]: makeUsage(b),
		},
		cursor: '2026-08-20',
	});
	const fetchImpl = createFetch(call => {
		const request = parseQueryRequest(call);
		assert.equal(request.fromSec, DAY_21_START / 1000);
		assert.equal(request.toSec, DAY_21_END / 1000);
		return groupedRows([
			[a, 1_000_000_000, 500_000_000, 10, 1],
			[b, 200, 300, 2, 1],
		]);
	});
	const summary = await run(env, fetchImpl);
	assert.equal(summary.ok, true);
	assert.deepEqual(summary.days, ['2026-08-21']);
	assert.equal(summary.sqlQueries, 1);
	assert.equal(summary.settledCustomers, 2);
	assert.equal(summary.kvWrites, 3, '2 customer puts + 1 cursor put');
	assert.equal(env.KV._store.get(CURSOR_KEY), '2026-08-21');

	const usageA = jsonParse(env.KV._store.get(USAGE_KEY + a));
	assert.equal(usageA.settledUsedBytes, 1_500_000_000);
	assert.equal(usageA.usageSettledThrough, DAY_21_START);
	assert.equal(usageA.usageUpdatedAt, NOW);
	assert.equal(usageA.revision, 2);
	const usageB = jsonParse(env.KV._store.get(USAGE_KEY + b));
	assert.equal(usageB.settledUsedBytes, 500);

	const customerOpsA = countsFor(env.KV, USAGE_KEY + a);
	assert.deepEqual(customerOpsA, { gets: 1, puts: 1 }, 'at most 1 get + 1 put per customer');
	assert.equal(env.KV._calls.gets.filter(key => key === CURSOR_KEY).length, 1);
	assert.equal(env.KV._calls.puts.filter(key => key === CURSOR_KEY).length, 1);
	assert.equal(env.KV._calls.gets.filter(key => key.startsWith(CUSTOMER_KEY)).length, 0, 'no base record reads');
});

test('customers with no traffic are not touched', async () => {
	const a = 'cus_AbCdEfGhIjKlMnOpQr1234';
	const idle = 'cus_AbCdEfGhIjKlMnOpQr5678';
	const env = makeEnv({
		usage: {
			[a]: makeUsage(a),
			[idle]: makeUsage(idle, { settledUsedBytes: 999 }),
		},
		cursor: '2026-08-20',
	});
	const fetchImpl = createFetch(() => groupedRows([[a, 10, 20, 1, 1]]));
	const summary = await run(env, fetchImpl);
	assert.equal(summary.settledCustomers, 1);
	assert.equal(summary.skippedCustomers, 0);
	assert.equal(env.KV._calls.gets.filter(key => key === USAGE_KEY + idle).length, 0);
	assert.equal(env.KV._store.get(USAGE_KEY + idle), JSON.stringify(makeUsage(idle, { settledUsedBytes: 999 })));
	assert.equal(env.KV._store.get(CURSOR_KEY), '2026-08-21');
});

// ------------------------------------------------------- repeated run

test('re-running the same day is a no-op (cursor already advanced)', async () => {
	const a = 'cus_AbCdEfGhIjKlMnOpQr1234';
	const env = makeEnv({ usage: { [a]: makeUsage(a) }, cursor: '2026-08-21' });
	const fetchImpl = createFetch(() => { throw new Error('must not be called'); });
	const summary = await run(env, fetchImpl);
	assert.equal(summary.ok, true);
	assert.deepEqual(summary.days, []);
	assert.equal(summary.sqlQueries, 0);
	assert.equal(summary.kvWrites, 0);
	assert.equal(fetchImpl.calls.length, 0);
	assert.equal(env.KV._calls.puts.length, 0);
});

test('interrupted run (customers written, cursor not advanced) does not double-accumulate', async () => {
	const a = 'cus_AbCdEfGhIjKlMnOpQr1234';
	const b = 'cus_AbCdEfGhIjKlMnOpQr5678';
	const settledA = makeUsage(a, { settledUsedBytes: 1500, usageSettledThrough: DAY_21_START, revision: 2 });
	const env = makeEnv({
		usage: {
			[a]: settledA,
			[b]: makeUsage(b),
		},
		cursor: '2026-08-20',
	});
	const fetchImpl = createFetch(() => groupedRows([
		[a, 1000, 500, 10, 1],
		[b, 100, 50, 2, 1],
	]));
	const summary = await run(env, fetchImpl);
	assert.equal(summary.ok, true);
	assert.equal(summary.settledCustomers, 1, 'only customer b is new for the day');
	assert.equal(summary.skippedCustomers, 1);
	assert.equal(summary.dayDetails[0].skipped[0].reason, 'already_settled');
	assert.equal(env.KV._store.get(USAGE_KEY + a), JSON.stringify(settledA), 'customer a must not be rewritten or double-added');
	assert.equal(jsonParse(env.KV._store.get(USAGE_KEY + b)).settledUsedBytes, 150);
	assert.equal(env.KV._store.get(CURSOR_KEY), '2026-08-21');
	assert.equal(countsFor(env.KV, USAGE_KEY + a).puts, 0);
});

// ------------------------------------------------------------ fault injection

test('day SQL 403 fails the day: no cursor advance, no customer KV writes', async () => {
	const a = 'cus_AbCdEfGhIjKlMnOpQr1234';
	const env = makeEnv({ usage: { [a]: makeUsage(a) }, cursor: '2026-08-20' });
	const fetchImpl = createFetch(() => sql403());
	const summary = await run(env, fetchImpl);
	assert.equal(summary.ok, false);
	assert.equal(summary.error, 'sql_http_403');
	assert.equal(summary.failedDay, '2026-08-21');
	assert.equal(env.KV._store.get(CURSOR_KEY), '2026-08-20', 'cursor must not advance');
	assert.equal(env.KV._calls.puts.length, 0, 'no customer KV writes');
	assert.equal(env.KV._store.get(USAGE_KEY + a), JSON.stringify(makeUsage(a)));
});

test('network failure fails the day without writes', async () => {
	const a = 'cus_AbCdEfGhIjKlMnOpQr1234';
	const env = makeEnv({ usage: { [a]: makeUsage(a) }, cursor: '2026-08-20' });
	const fetchImpl = createFetch(() => { throw new Error('simulated network failure'); });
	const summary = await run(env, fetchImpl);
	assert.equal(summary.ok, false);
	assert.equal(summary.error, 'sql_network');
	assert.equal(env.KV._store.get(CURSOR_KEY), '2026-08-20');
	assert.equal(env.KV._calls.puts.length, 0);
});

test('malformed SQL response fails the day without writes', async () => {
	const env = makeEnv({ cursor: '2026-08-20' });
	const fetchImpl = createFetch(() => jsonResponse(200, { meta: [], data: 'boom' }));
	const summary = await run(env, fetchImpl);
	assert.equal(summary.ok, false);
	assert.equal(summary.error, 'sql_invalid_response');
	assert.equal(env.KV._store.get(CURSOR_KEY), '2026-08-20');
	assert.equal(env.KV._calls.puts.length, 0);
});

test('corrupt usage record is skipped and reported while the day completes', async () => {
	const a = 'cus_AbCdEfGhIjKlMnOpQr1234';
	const b = 'cus_AbCdEfGhIjKlMnOpQr5678';
	const env = makeEnv({
		usage: {
			[a]: '{corrupt',
			[b]: makeUsage(b),
		},
		cursor: '2026-08-20',
	});
	const fetchImpl = createFetch(() => groupedRows([
		[a, 100, 100, 2, 1],
		[b, 50, 50, 1, 1],
	]));
	const summary = await run(env, fetchImpl);
	assert.equal(summary.ok, true);
	assert.equal(summary.settledCustomers, 1);
	assert.equal(summary.skippedCustomers, 1);
	assert.equal(summary.dayDetails[0].skipped[0].reason, 'invalid_usage_record');
	assert.equal(env.KV._store.get(CURSOR_KEY), '2026-08-21', 'day still completes');
	assert.equal(env.KV._store.get(USAGE_KEY + a), '{corrupt', 'corrupt record must not be overwritten');
});

test('missing usage record is skipped and reported', async () => {
	const a = 'cus_AbCdEfGhIjKlMnOpQr1234';
	const b = 'cus_AbCdEfGhIjKlMnOpQr5678';
	const env = makeEnv({ usage: { [b]: makeUsage(b) }, cursor: '2026-08-20' });
	const fetchImpl = createFetch(() => groupedRows([
		[a, 100, 100, 2, 1],
		[b, 50, 50, 1, 1],
	]));
	const summary = await run(env, fetchImpl);
	assert.equal(summary.ok, true);
	assert.equal(summary.settledCustomers, 1);
	assert.equal(summary.skippedCustomers, 1);
	assert.equal(summary.dayDetails[0].skipped[0].reason, 'missing_usage');
	assert.equal(env.KV._store.get(CURSOR_KEY), '2026-08-21');
});

test('a permanently missing customer never blocks the day cursor across days', async () => {
	const ghost = 'cus_AbCdEfGhIjKlMnOpQr1234';
	const real = 'cus_AbCdEfGhIjKlMnOpQr5678';
	const env = makeEnv({ usage: { [real]: makeUsage(real) }, cursor: '2026-08-19' });
	const fetchImpl = createFetch(call => {
		const request = parseQueryRequest(call);
		if (request.fromSec === Date.UTC(2026, 7, 19, 16) / 1000) return groupedRows([[ghost, 100, 100, 2, 1]]);
		return groupedRows([[real, 10, 10, 1, 1]]);
	});
	const summary = await run(env, fetchImpl);
	assert.equal(summary.ok, true);
	assert.deepEqual(summary.days, ['2026-08-20', '2026-08-21']);
	assert.equal(summary.skippedCustomers, 1, 'ghost skipped on day 20');
	assert.equal(summary.settledCustomers, 1, 'real customer settled on day 21');
	assert.equal(env.KV._store.get(CURSOR_KEY), '2026-08-21', 'cursor advances despite the ghost');
	assert.ok(summary.dayDetails.every(day => day.blocked === false));
});

test('usage record that is not schemaVersion 4 is skipped without blocking the cursor', async () => {
	const a = 'cus_AbCdEfGhIjKlMnOpQr1234';
	const legacy = JSON.stringify({ schemaVersion: 3, customerId: a, kind: 'membership-usage', name: 'x' });
	const env = makeEnv({ usage: { [a]: legacy }, cursor: '2026-08-20' });
	const fetchImpl = createFetch(() => groupedRows([[a, 100, 100, 2, 1]]));
	const summary = await run(env, fetchImpl);
	assert.equal(summary.ok, true);
	assert.equal(summary.skippedCustomers, 1);
	assert.equal(summary.dayDetails[0].skipped[0].reason, 'invalid_usage_record');
	assert.equal(summary.failedCustomers, 0);
	assert.equal(env.KV._store.get(CURSOR_KEY), '2026-08-21', 'definitive invalid record does not block');
	assert.equal(env.KV._store.get(USAGE_KEY + a), legacy, 'invalid record must not be overwritten');
});

test('pure computation overflow is a definitive skip, not a cursor blocker', async () => {
	const a = 'cus_AbCdEfGhIjKlMnOpQr1234';
	const env = makeEnv({
		usage: { [a]: makeUsage(a, { settledUsedBytes: Number.MAX_SAFE_INTEGER - 10, usageSettledThrough: DAY_21_START - 86_400_000 }) },
		cursor: '2026-08-20',
	});
	const fetchImpl = createFetch(() => groupedRows([[a, 20, 20, 1, 1]]));
	const summary = await run(env, fetchImpl);
	assert.equal(summary.ok, true);
	assert.equal(summary.skippedCustomers, 1);
	assert.equal(summary.dayDetails[0].skipped[0].reason, 'invalid_aggregate');
	assert.equal(summary.failedCustomers, 0);
	assert.equal(env.KV._store.get(CURSOR_KEY), '2026-08-21');
});

test('KV get failure blocks the day cursor and recovers on re-run', async () => {
	const a = 'cus_AbCdEfGhIjKlMnOpQr1234';
	const b = 'cus_AbCdEfGhIjKlMnOpQr5678';
	const env = makeEnv({
		usage: {
			[a]: makeUsage(a),
			[b]: makeUsage(b),
		},
		cursor: '2026-08-20',
		hooks: { failGet: new Set([USAGE_KEY + a]) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		[a, 100, 100, 2, 1],
		[b, 50, 50, 1, 1],
	]));
	const first = await run(env, fetchImpl);
	assert.equal(first.ok, false);
	assert.equal(first.error, 'day_blocked_by_kv_errors');
	assert.equal(first.blockedDay, '2026-08-21');
	assert.equal(first.blockedCustomers[0].customerId, a);
	assert.equal(first.blockedCustomers[0].error, 'kv_get_failed');
	assert.equal(env.KV._store.get(CURSOR_KEY), '2026-08-20', 'cursor must not advance on KV get failure');
	assert.equal(env.KV._store.get(USAGE_KEY + b), JSON.stringify(makeUsage(b, { settledUsedBytes: 100, usageSettledThrough: DAY_21_START, usageUpdatedAt: NOW, revision: 2 })));

	env.KV._hooks.failGet.clear();
	const second = await run(env, fetchImpl, NOW);
	assert.equal(second.ok, true);
	assert.equal(second.settledCustomers, 1, 'only customer a is retried');
	assert.equal(second.skippedCustomers, 1, 'customer b is skipped via idempotency marker');
	assert.equal(jsonParse(env.KV._store.get(USAGE_KEY + a)).settledUsedBytes, 200);
	assert.equal(jsonParse(env.KV._store.get(USAGE_KEY + b)).settledUsedBytes, 100, 'customer b must not double-accumulate');
	assert.equal(env.KV._store.get(CURSOR_KEY), '2026-08-21', 'cursor advances after recovery');
});

test('KV put failure blocks the day cursor; re-run retries only the failed customer', async () => {
	const a = 'cus_AbCdEfGhIjKlMnOpQr1234';
	const b = 'cus_AbCdEfGhIjKlMnOpQr5678';
	const env = makeEnv({
		usage: {
			[a]: makeUsage(a),
			[b]: makeUsage(b),
		},
		cursor: '2026-08-20',
		hooks: { failPut: new Set([USAGE_KEY + a]) },
	});
	const fetchImpl = createFetch(() => groupedRows([
		[a, 100, 100, 2, 1],
		[b, 50, 50, 1, 1],
	]));
	const first = await run(env, fetchImpl);
	assert.equal(first.ok, false);
	assert.equal(first.error, 'day_blocked_by_kv_errors');
	assert.equal(first.blockedDay, '2026-08-21');
	assert.equal(first.blockedCustomers[0].error, 'kv_put_failed');
	assert.equal(env.KV._store.get(CURSOR_KEY), '2026-08-20', 'cursor must not advance on KV put failure');
	assert.equal(env.KV._store.get(USAGE_KEY + a), JSON.stringify(makeUsage(a)), 'failed customer not written');
	assert.equal(jsonParse(env.KV._store.get(USAGE_KEY + b)).settledUsedBytes, 100, 'successful customer keeps its marker');

	env.KV._hooks.failPut.clear();
	const second = await run(env, fetchImpl, NOW);
	assert.equal(second.ok, true);
	assert.equal(second.settledCustomers, 1, 'only customer a is retried');
	assert.equal(second.skippedCustomers, 1, 'customer b skipped via marker');
	assert.equal(jsonParse(env.KV._store.get(USAGE_KEY + a)).settledUsedBytes, 200);
	assert.equal(jsonParse(env.KV._store.get(USAGE_KEY + b)).settledUsedBytes, 100, 'no double accumulation');
	assert.equal(env.KV._store.get(CURSOR_KEY), '2026-08-21', 'cursor advances after second success');
});

test('invalid SQL rows are reported but do not fail the day', async () => {
	const a = 'cus_AbCdEfGhIjKlMnOpQr1234';
	const env = makeEnv({ usage: { [a]: makeUsage(a) }, cursor: '2026-08-20' });
	const fetchImpl = createFetch(() => groupedRows([
		['not-a-customer', 100, 100, 2, 1],
		[a, -5, 100, 2, 1],
		[a, 50, 50, 1, 1],
	]));
	const summary = await run(env, fetchImpl);
	assert.equal(summary.ok, true);
	assert.equal(summary.settledCustomers, 1, 'valid customer row still settles');
	assert.equal(summary.skippedCustomers, 2, 'two invalid rows reported');
	assert.equal(env.KV._store.get(CURSOR_KEY), '2026-08-21');
});

test('cursor put failure stops the run but re-run does not double-accumulate', async () => {
	const a = 'cus_AbCdEfGhIjKlMnOpQr1234';
	const env = makeEnv({
		usage: { [a]: makeUsage(a) },
		cursor: '2026-08-20',
		hooks: { failPut: new Set([CURSOR_KEY]) },
	});
	const fetchImpl = createFetch(() => groupedRows([[a, 1000, 500, 10, 1]]));

	const first = await run(env, fetchImpl);
	assert.equal(first.ok, false);
	assert.equal(first.error, 'cursor_put_failed');
	assert.equal(first.failedDay, '2026-08-21');
	assert.equal(env.KV._store.get(CURSOR_KEY), '2026-08-20', 'cursor did not advance');
	assert.equal(jsonParse(env.KV._store.get(USAGE_KEY + a)).settledUsedBytes, 1500, 'customer write happened');

	env.KV._hooks.failPut.clear();
	const second = await run(env, fetchImpl, NOW);
	assert.equal(second.ok, true);
	assert.equal(second.settledCustomers, 0, 'customer already settled for the day');
	assert.equal(second.skippedCustomers, 1);
	assert.equal(jsonParse(env.KV._store.get(USAGE_KEY + a)).settledUsedBytes, 1500, 'no double accumulation');
	assert.equal(env.KV._store.get(CURSOR_KEY), '2026-08-21');
});

// ------------------------------------------------------------ backfill

test('missed runs backfill sequentially across days', async () => {
	const a = 'cus_AbCdEfGhIjKlMnOpQr1234';
	const env = makeEnv({ usage: { [a]: makeUsage(a) }, cursor: '2026-08-19' });
	const fetchImpl = createFetch(call => {
		const request = parseQueryRequest(call);
		if (request.fromSec === Date.UTC(2026, 7, 19, 16) / 1000) return groupedRows([[a, 100, 50, 1, 1]]);
		if (request.fromSec === Date.UTC(2026, 7, 20, 16) / 1000) return groupedRows([[a, 200, 100, 2, 1]]);
		throw new Error(`unexpected window: ${request.fromSec}`);
	});
	const summary = await run(env, fetchImpl);
	assert.equal(summary.ok, true);
	assert.deepEqual(summary.days, ['2026-08-20', '2026-08-21']);
	assert.equal(summary.sqlQueries, 2);
	assert.equal(summary.settledCustomers, 2, 'two daily settlements for the same customer');
	assert.equal(jsonParse(env.KV._store.get(USAGE_KEY + a)).settledUsedBytes, 450);
	assert.equal(jsonParse(env.KV._store.get(USAGE_KEY + a)).usageSettledThrough, DAY_21_START);
	assert.equal(env.KV._store.get(CURSOR_KEY), '2026-08-21');
});

test('backfill is capped at the configured window and reports skipped days', async () => {
	const a = 'cus_AbCdEfGhIjKlMnOpQr1234';
	const env = makeEnv({ usage: { [a]: makeUsage(a) }, cursor: '2026-08-10' });
	const fetchImpl = createFetch(() => groupedRows([[a, 10, 10, 1, 1]]));
	const summary = await run(env, fetchImpl);
	assert.equal(summary.ok, true);
	assert.deepEqual(summary.days, ['2026-08-19', '2026-08-20', '2026-08-21']);
	assert.equal(summary.skippedDays.length, 8);
	assert.equal(summary.sqlQueries, 3);
	assert.equal(env.KV._store.get(CURSOR_KEY), '2026-08-21');
});

test('a day with no traffic completes and advances the cursor with zero customer KV ops', async () => {
	const a = 'cus_AbCdEfGhIjKlMnOpQr1234';
	const env = makeEnv({ usage: { [a]: makeUsage(a) }, cursor: '2026-08-20' });
	const fetchImpl = createFetch(() => groupedRows([]));
	const summary = await run(env, fetchImpl);
	assert.equal(summary.ok, true);
	assert.equal(summary.sqlQueries, 1);
	assert.equal(summary.customers, 0);
	assert.equal(summary.kvWrites, 1, 'only the cursor put');
	assert.equal(env.KV._store.get(CURSOR_KEY), '2026-08-21');
	assert.equal(countsFor(env.KV, USAGE_KEY + a).gets, 0);
	assert.equal(countsFor(env.KV, USAGE_KEY + a).puts, 0);
});

test('quotaExceeded is recomputed on daily settlement', async () => {
	const a = 'cus_AbCdEfGhIjKlMnOpQr1234';
	const env = makeEnv({
		usage: { [a]: makeUsage(a, { quotaBytes: 1500, settledUsedBytes: 1000, usageSettledThrough: DAY_21_START - 86_400_000 }) },
		cursor: '2026-08-20',
	});
	const fetchImpl = createFetch(() => groupedRows([[a, 400, 200, 2, 1]]));
	const summary = await run(env, fetchImpl);
	assert.equal(summary.settledCustomers, 1);
	const usage = jsonParse(env.KV._store.get(USAGE_KEY + a));
	assert.equal(usage.settledUsedBytes, 1600);
	assert.equal(usage.quotaExceeded, true);
});

// ------------------------------------------------------------ config gating

test('config gating: disabled, invalid account, invalid timezone', async () => {
	const cases = [
		{ settings: { MEMBERSHIP_USAGE_SETTLEMENT_ENABLED: 'false' }, expected: 'disabled' },
		{ settings: { MEMBERSHIP_USAGE_ACCOUNT_ID: 'not-hex' }, expected: 'invalid_account_id' },
		{ settings: { MEMBERSHIP_USAGE_DATASET: 'bad dataset' }, expected: 'invalid_dataset' },
		{ settings: { MEMBERSHIP_USAGE_SETTLEMENT_TIMEZONE: 'Not/AZone' }, expected: 'invalid_timezone' },
	];
	for (const { settings, expected } of cases) {
		const env = makeEnv({ usage: {}, cursor: '2026-08-20', settings });
		const fetchImpl = createFetch(() => { throw new Error('must not be called'); });
		const summary = await run(env, fetchImpl);
		assert.equal(summary.ok, false);
		assert.equal(summary.skipped, expected);
		assert.equal(fetchImpl.calls.length, 0);
		assert.equal(env.KV._calls.puts.length, 0);
	}
});

test('missing KV binding or fetch implementation fails safely', async () => {
	const fetchImpl = createFetch(() => { throw new Error('must not be called'); });
	const configEnv = {
		MEMBERSHIP_USAGE_SETTLEMENT_ENABLED: 'true',
		MEMBERSHIP_USAGE_ACCOUNT_ID: ACCOUNT_ID,
		MEMBERSHIP_USAGE_API_TOKEN: 'test-token',
		MEMBERSHIP_USAGE_DATASET: DATASET,
	};
	const noKv = await runMembershipUsageSettlement({ env: configEnv, fetchImpl, nowMs: NOW });
	assert.equal(noKv.ok, false);
	assert.equal(noKv.error, 'kv_unavailable');
	const noFetch = await runMembershipUsageSettlement({ env: { ...configEnv, KV: createKv() }, fetchImpl: null, nowMs: NOW });
	assert.equal(noFetch.ok, false);
	assert.equal(noFetch.error, 'fetch_unavailable');
});

test('config defaults are sane', () => {
	const config = getMembershipSettlementConfig(makeEnv({ settings: {} }));
	assert.equal(config.timezone, TZ);
	assert.equal(config.maxBackfillDays, 3);
	assert.equal(config.concurrency, 8);
	assert.equal(validateSettlementConfig(config).ok, true);
});
