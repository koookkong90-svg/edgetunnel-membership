// Membership usage settlement — daily batch from Cloudflare Workers Analytics Engine (SQL API).
//
// Business rules:
// - Customer plans are measured in days and traffic accounting does not need to be exact.
//   Over-quota customers are rejected by the existing auth path on new connections;
//   established connections are not torn down immediately.
// - One SQL query per completed natural day (GROUP BY index1/customerId). There are no
//   per-customer Analytics Engine requests.
// - A global day cursor (`settlement:global:lastCompletedDay`) advances only after a day's
//   SQL query succeeds AND no customer hit a temporary KV error (usage record get/put
//   failure). A day with such errors still writes its successful customers (each with the
//   day-boundary idempotency marker) but does not advance the cursor, so the next run
//   retries only the failed customers. A failed SQL query writes no customer KV and stops
//   the run.
// - Missed runs are backfilled sequentially for at most `maxBackfillDays` (default 3).
// - Per-customer idempotency: `usageSettledThrough` stores the UTC ms of the settled local
//   day boundary. A customer whose marker is already at/after the day boundary is skipped,
//   so re-running the same day never double-accumulates.
// - Per customer with traffic: exactly 1 KV get + 1 KV put. Missing/corrupt records are
//   skipped and reported; the day still completes.
//
// This module is deliberately self-contained (no imports from _worker.js) so it can be
// exercised by the local test suite with injected fetch/KV mocks.

const MEMBERSHIP_USAGE_KEY_PREFIX = 'membership:usage:';
const MEMBERSHIP_USAGE_RECORD_TYPE = 'usage-v1';
const MEMBERSHIP_USAGE_POLICY_VERSION = 'usage-v1';
const MEMBERSHIP_USAGE_TRANSPORT = 'vless-ws';
const MEMBERSHIP_SETTLEMENT_CURSOR_KEY = 'settlement:global:lastCompletedDay';

const MEMBERSHIP_USAGE_FIELDS = [
	'schemaVersion',
	'kind',
	'customerId',
	'quotaBytes',
	'settledUsedBytes',
	'quotaExceeded',
	'usageUpdatedAt',
	'usageSettledThrough',
	'unlimitedTraffic',
	'revision',
];

const CUSTOMER_ID_PATTERN = /^cus_[A-Za-z0-9_-]{16,128}$/;
const DATASET_PATTERN = /^[A-Za-z0-9_]{1,128}$/;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DEFAULT_TIMEZONE = 'Asia/Shanghai';

function sqlError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

function positiveInteger(value, fallback, max) {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

function getMembershipSettlementConfig(env = {}) {
	const enabled = ['1', 'true', 'yes'].includes(String(env?.MEMBERSHIP_USAGE_SETTLEMENT_ENABLED ?? '').trim().toLowerCase());
	return {
		enabled,
		accountId: String(env?.MEMBERSHIP_USAGE_ACCOUNT_ID ?? '').trim(),
		apiToken: String(env?.MEMBERSHIP_USAGE_API_TOKEN ?? ''),
		dataset: String(env?.MEMBERSHIP_USAGE_DATASET ?? '').trim(),
		timezone: String(env?.MEMBERSHIP_USAGE_SETTLEMENT_TIMEZONE ?? '').trim() || DEFAULT_TIMEZONE,
		maxBackfillDays: positiveInteger(env?.MEMBERSHIP_USAGE_SETTLEMENT_MAX_BACKFILL_DAYS, 3, 7),
		concurrency: positiveInteger(env?.MEMBERSHIP_USAGE_SETTLEMENT_CONCURRENCY, 8, 32),
	};
}

function validateSettlementConfig(config) {
	if (!config?.enabled) return { ok: false, reason: 'disabled' };
	if (typeof config.accountId !== 'string' || !ACCOUNT_ID_PATTERN.test(config.accountId)) return { ok: false, reason: 'invalid_account_id' };
	if (typeof config.apiToken !== 'string' || config.apiToken.length === 0) return { ok: false, reason: 'missing_api_token' };
	if (typeof config.dataset !== 'string' || !DATASET_PATTERN.test(config.dataset)) return { ok: false, reason: 'invalid_dataset' };
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: config.timezone });
	} catch (_) {
		return { ok: false, reason: 'invalid_timezone' };
	}
	return { ok: true };
}

function sqlEndpoint(accountId) {
	return `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
}

// ---------------------------------------------------------------- day math

function parseDayKey(dayKey) {
	const match = DAY_KEY_PATTERN.exec(dayKey);
	if (!match) return null;
	return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function formatDayKey(year, month, day) {
	return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addDays(dayKey, delta) {
	const parsed = parseDayKey(dayKey);
	if (!parsed) throw sqlError('invalid_day', `Invalid day key: ${dayKey}`);
	const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + delta));
	return formatDayKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function nextDayKey(dayKey) {
	return addDays(dayKey, 1);
}

function dayPartsInTimeZone(nowMs, timeZone) {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	}).formatToParts(nowMs);
	const values = {};
	for (const part of parts) {
		if (part.type !== 'literal') values[part.type] = Number(part.value);
	}
	return values;
}

// Converts a wall-clock time in the given IANA timezone to UTC epoch ms.
// Exact except for local times that fall inside a DST gap/overlap around the
// conversion instant; day boundaries at midnight are unambiguous in all
// commonly used zones (Asia/Shanghai has no DST at all).
function zonedTimeToUtcMs(timeZone, year, month, day, hour = 0, minute = 0, second = 0) {
	const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);
	const values = dayPartsInTimeZone(naiveUtc, timeZone);
	const wallUtc = Date.UTC(values.year, values.month - 1, values.day, values.hour % 24, values.minute, values.second);
	return naiveUtc - (wallUtc - naiveUtc);
}

function dayStartUtcMs(dayKey, timeZone) {
	const parsed = parseDayKey(dayKey);
	if (!parsed) throw sqlError('invalid_day', `Invalid day key: ${dayKey}`);
	return zonedTimeToUtcMs(timeZone, parsed.year, parsed.month, parsed.day);
}

function dayEndUtcMs(dayKey, timeZone) {
	return dayStartUtcMs(nextDayKey(dayKey), timeZone);
}

function localDayKey(nowMs, timeZone) {
	const values = dayPartsInTimeZone(nowMs, timeZone);
	return formatDayKey(values.year, values.month, values.day);
}

function calendarDaysBetween(startKey, endKey) {
	const days = [];
	let current = startKey;
	let guard = 0;
	while (current <= endKey && guard < 400) {
		days.push(current);
		current = nextDayKey(current);
		guard++;
	}
	return days;
}

// Plans the completed days to settle. `todayKey` is the current local day; only
// fully ended natural days (strictly before today) are ever processed.
// Returns the ordered days to settle plus any days that were skipped because
// they fell outside the backfill window.
function planSettlementDays(cursorDay, todayKey, maxBackfillDays) {
	const windowStart = addDays(todayKey, -maxBackfillDays);
	const windowEnd = addDays(todayKey, -1);
	if (cursorDay === null || cursorDay === undefined || cursorDay === '') cursorDay = null;
	if (cursorDay !== null && !DAY_KEY_PATTERN.test(cursorDay)) {
		throw sqlError('invalid_cursor', `Invalid settlement cursor: ${cursorDay}`);
	}
	let start = cursorDay === null ? windowStart : addDays(cursorDay, 1);
	const skippedDays = [];
	if (start < windowStart) {
		skippedDays.push(...calendarDaysBetween(start, addDays(windowStart, -1)));
		start = windowStart;
	}
	if (start > windowEnd) return { days: [], skippedDays };
	return { days: calendarDaysBetween(start, windowEnd), skippedDays };
}

// ---------------------------------------------------------------- SQL API

// One grouped query per completed natural day. Doubles written by the tracker:
// [upload, download, sampleWeight, 1]. `_sample_interval` is the platform sampling
// factor and `double3` is our own write-time sample weight; multiplying by both
// restores the true byte volume (see the Analytics Engine SQL API docs).
function buildMembershipUsageDayQuery({ dataset, recordType = MEMBERSHIP_USAGE_RECORD_TYPE, policyVersion = MEMBERSHIP_USAGE_POLICY_VERSION }, dayKey, timeZone) {
	if (typeof dataset !== 'string' || !DATASET_PATTERN.test(dataset)) throw sqlError('invalid_dataset', 'Invalid Analytics Engine dataset name');
	const fromMs = dayStartUtcMs(dayKey, timeZone);
	const toMs = dayEndUtcMs(dayKey, timeZone);
	const fromSec = Math.floor(fromMs / 1000);
	const toSec = Math.floor(toMs / 1000);
	return [
		'SELECT',
		'  index1 AS customerId,',
		'  SUM(_sample_interval * double3 * double1) AS uploadBytes,',
		'  SUM(_sample_interval * double3 * double2) AS downloadBytes,',
		'  SUM(_sample_interval * double4) AS pointCount,',
		'  COUNT() AS rowCount',
		`FROM ${dataset}`,
		`WHERE blob1 = '${recordType}'`,
		`  AND blob2 = '${MEMBERSHIP_USAGE_TRANSPORT}'`,
		`  AND blob4 = '${policyVersion}'`,
		`  AND timestamp >= toDateTime(${fromSec})`,
		`  AND timestamp < toDateTime(${toSec})`,
		'GROUP BY index1',
	].join('\n');
}

function extractApiErrorMessage(payload) {
	if (!payload || typeof payload !== 'object') return null;
	if (Array.isArray(payload.errors) && payload.errors.length) {
		const first = payload.errors[0];
		if (first && typeof first.message === 'string' && first.message) return first.message;
	}
	if (Array.isArray(payload.messages) && payload.messages.length) {
		const first = payload.messages[0];
		if (first && typeof first.message === 'string' && first.message) return first.message;
	}
	if (typeof payload.exception === 'string' && payload.exception) return payload.exception;
	if (payload.data && typeof payload.data.exception === 'string' && payload.data.exception) return payload.data.exception;
	return null;
}

const ROW_KEY_ALIASES = {
	customerid: 'customerId',
	customer_id: 'customerId',
	uploadbytes: 'uploadBytes',
	upload_bytes: 'uploadBytes',
	downloadbytes: 'downloadBytes',
	download_bytes: 'downloadBytes',
	pointcount: 'pointCount',
	point_count: 'pointCount',
	rowcount: 'rowCount',
	row_count: 'rowCount',
};

function normalizeRow(row) {
	if (row === null || typeof row !== 'object') return null;
	const normalized = {};
	for (const [key, value] of Object.entries(row)) {
		normalized[ROW_KEY_ALIASES[key.toLowerCase()] || key] = value;
	}
	return normalized;
}

function rowsFromPayload(payload) {
	if (Array.isArray(payload)) return payload.map(normalizeRow);
	if (payload && typeof payload === 'object' && Array.isArray(payload.data)) {
		const meta = Array.isArray(payload.meta) ? payload.meta : null;
		const names = meta && meta.length
			? meta.map(entry => (entry && typeof entry === 'object' ? entry.name : entry))
			: null;
		const firstRow = payload.data.find(row => row !== null && row !== undefined);
		if (Array.isArray(firstRow)) {
			if (!names || names.some(name => typeof name !== 'string')) {
				throw sqlError('sql_invalid_response', 'SQL API returned array rows without column metadata');
			}
			return payload.data.map(row => {
				if (row === null || row === undefined) return null;
				if (!Array.isArray(row)) return normalizeRow(row);
				const objectRow = {};
				names.forEach((name, index) => {
					objectRow[ROW_KEY_ALIASES[name.toLowerCase()] || name] = row[index];
				});
				return objectRow;
			});
		}
		return payload.data.map(normalizeRow);
	}
	if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'data') && payload.data !== null && payload.data !== undefined) {
		throw sqlError('sql_invalid_response', 'SQL API returned a malformed data payload');
	}
	return [];
}

function parseSqlJsonResponse(text) {
	let payload;
	try {
		payload = JSON.parse(text);
	} catch (_) {
		throw sqlError('sql_invalid_response', 'SQL API returned invalid JSON');
	}
	if (payload && typeof payload === 'object' && payload.success === false) {
		throw sqlError('sql_api_error', extractApiErrorMessage(payload) || 'SQL API reported an error');
	}
	return rowsFromPayload(payload);
}

function toFiniteNonNegative(value, fieldName) {
	if (value === null || value === undefined || value === '') return 0;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw sqlError('sql_data_invalid', `SQL aggregate field ${fieldName} is invalid: ${String(value)}`);
	}
	return parsed;
}

function extractUsageAggregate(row) {
	if (row === null || typeof row !== 'object') {
		throw sqlError('sql_data_invalid', 'SQL aggregate row is missing');
	}
	const uploadBytes = Math.round(toFiniteNonNegative(row.uploadBytes, 'uploadBytes'));
	const downloadBytes = Math.round(toFiniteNonNegative(row.downloadBytes, 'downloadBytes'));
	const pointCount = toFiniteNonNegative(row.pointCount, 'pointCount');
	const rowCount = toFiniteNonNegative(row.rowCount, 'rowCount');
	if (!Number.isSafeInteger(uploadBytes) || !Number.isSafeInteger(downloadBytes)) {
		throw sqlError('sql_data_invalid', 'SQL aggregate bytes exceed the safe integer range');
	}
	return { uploadBytes, downloadBytes, pointCount, rowCount };
}

function parseDayRow(row) {
	const normalized = normalizeRow(row);
	if (!normalized) throw sqlError('sql_data_invalid', 'SQL row is missing');
	const customerId = normalized.customerId;
	if (typeof customerId !== 'string' || !CUSTOMER_ID_PATTERN.test(customerId)) {
		throw sqlError('sql_data_invalid', `Invalid customer id in SQL row: ${String(customerId)}`);
	}
	return { customerId, ...extractUsageAggregate(normalized) };
}

async function queryAnalyticsEngineSql(fetchImpl, config, query) {
	let response;
	try {
		response = await fetchImpl(sqlEndpoint(config.accountId), {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${config.apiToken}`,
				'Content-Type': 'text/plain',
			},
			body: query,
		});
	} catch (error) {
		throw sqlError('sql_network', `SQL request failed: ${error?.message || error}`);
	}
	if (!response || typeof response.status !== 'number') {
		throw sqlError('sql_invalid_response', 'SQL API returned an invalid response object');
	}
	if (response.status < 200 || response.status >= 300) {
		let message = `SQL API returned HTTP ${response.status}`;
		try {
			const text = typeof response.text === 'function' ? await response.text() : '';
			if (text) message = extractApiErrorMessage(JSON.parse(text)) || message;
		} catch (_) { /* keep the HTTP status message */ }
		throw sqlError(`sql_http_${response.status}`, message);
	}
	let text;
	try {
		text = typeof response.text === 'function' ? await response.text() : String(response);
	} catch (error) {
		throw sqlError('sql_invalid_response', `SQL response body could not be read: ${error?.message || error}`);
	}
	return parseSqlJsonResponse(text);
}

// ---------------------------------------------------------------- records

function parseUsageRecord(value) {
	let usage = value;
	if (typeof value === 'string') {
		try {
			usage = JSON.parse(value);
		} catch (_) {
			throw sqlError('invalid_usage_record', 'Invalid membership usage record');
		}
	}
	const valid = usage && typeof usage === 'object'
		&& MEMBERSHIP_USAGE_FIELDS.every(field => Object.prototype.hasOwnProperty.call(usage, field))
		&& Object.keys(usage).length === MEMBERSHIP_USAGE_FIELDS.length
		&& usage.schemaVersion === 4
		&& usage.kind === 'membership-usage'
		&& typeof usage.customerId === 'string' && CUSTOMER_ID_PATTERN.test(usage.customerId)
		&& Number.isSafeInteger(usage.settledUsedBytes) && usage.settledUsedBytes >= 0
		&& Number.isSafeInteger(usage.usageUpdatedAt) && usage.usageUpdatedAt >= 0
		&& Number.isSafeInteger(usage.usageSettledThrough) && usage.usageSettledThrough >= 0
		&& typeof usage.quotaExceeded === 'boolean'
		&& typeof usage.unlimitedTraffic === 'boolean'
		&& (usage.unlimitedTraffic === true ? usage.quotaBytes === null : Number.isSafeInteger(usage.quotaBytes) && usage.quotaBytes > 0)
		&& Number.isSafeInteger(usage.revision) && usage.revision >= 1;
	if (!valid) throw sqlError('invalid_usage_record', 'Invalid membership usage record');
	return usage;
}

// Applies one day's aggregate to a usage record. `settledThroughMs` is the UTC ms of the
// settled local day boundary, which doubles as the per-customer idempotency marker.
function computeMembershipUsageSettlement(usage, aggregate, settledThroughMs, nowMs) {
	const parsed = parseUsageRecord(usage);
	if (!Number.isSafeInteger(settledThroughMs) || settledThroughMs < 0 || !Number.isSafeInteger(nowMs) || nowMs < 0) {
		throw sqlError('invalid_window', 'Invalid settlement timestamps');
	}
	if (settledThroughMs <= parsed.usageSettledThrough) throw sqlError('window_not_advancing', 'Settlement day does not advance the customer marker');
	if (!aggregate || !Number.isSafeInteger(aggregate.uploadBytes) || aggregate.uploadBytes < 0
		|| !Number.isSafeInteger(aggregate.downloadBytes) || aggregate.downloadBytes < 0) {
		throw sqlError('invalid_aggregate', 'Invalid usage aggregate');
	}
	const additionalBytes = aggregate.uploadBytes + aggregate.downloadBytes;
	if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) throw sqlError('invalid_aggregate', 'Settled bytes overflow');
	const settledUsedBytes = parsed.settledUsedBytes + additionalBytes;
	if (!Number.isSafeInteger(settledUsedBytes) || settledUsedBytes < parsed.settledUsedBytes) throw sqlError('invalid_aggregate', 'Settled bytes overflow');
	const usageRevision = parsed.revision + 1;
	if (!Number.isSafeInteger(usageRevision) || usageRevision < 2) throw sqlError('invalid_record', 'Usage revision overflow');
	return {
		schemaVersion: 4,
		kind: 'membership-usage',
		customerId: parsed.customerId,
		quotaBytes: parsed.quotaBytes,
		settledUsedBytes,
		quotaExceeded: parsed.unlimitedTraffic === false && settledUsedBytes >= parsed.quotaBytes,
		usageUpdatedAt: nowMs,
		usageSettledThrough: settledThroughMs,
		unlimitedTraffic: parsed.unlimitedTraffic,
		revision: usageRevision,
	};
}

// ---------------------------------------------------------------- day pipeline

async function kvGet(env, key) {
	try {
		return await env.KV.get(key);
	} catch (error) {
		const wrapped = new Error(`KV get failed for ${key}: ${error?.message || error}`);
		wrapped.code = 'kv_get_failed';
		throw wrapped;
	}
}

async function kvPut(env, key, value) {
	try {
		return await env.KV.put(key, value);
	} catch (error) {
		const wrapped = new Error(`KV put failed for ${key}: ${error?.message || error}`);
		wrapped.code = 'kv_put_failed';
		throw wrapped;
	}
}

async function mapWithConcurrency(items, concurrency, mapper) {
	const results = new Array(items.length);
	let nextIndex = 0;
	async function worker() {
		while (nextIndex < items.length) {
			const index = nextIndex++;
			results[index] = await mapper(items[index], index);
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
	return results;
}

// One KV get + one KV put per customer with traffic. Missing/corrupt records and
// KV errors are reported per customer; the day itself still completes.
async function processDayCustomer({ env, customerId, aggregate, dayStartMs, nowMs }) {
	let raw;
	try {
		raw = await kvGet(env, MEMBERSHIP_USAGE_KEY_PREFIX + customerId);
	} catch (error) {
		return { customerId, status: 'failed', error: error.code, message: error.message };
	}
	if (raw === null || raw === undefined) return { customerId, status: 'skipped', reason: 'missing_usage' };
	let usage;
	try {
		usage = parseUsageRecord(raw);
	} catch (error) {
		return { customerId, status: 'skipped', reason: error.code || 'invalid_usage_record', message: error.message };
	}
	if (usage.usageSettledThrough >= dayStartMs) {
		return { customerId, status: 'skipped', reason: 'already_settled' };
	}
	let updated;
	try {
		updated = computeMembershipUsageSettlement(usage, aggregate, dayStartMs, nowMs);
	} catch (error) {
		// Pure computation failure is definitive (same input throws every time), so it is
		// reported as a skip and does not block the day cursor.
		return { customerId, status: 'skipped', reason: error.code || 'invalid_record', message: error.message };
	}
	try {
		await kvPut(env, MEMBERSHIP_USAGE_KEY_PREFIX + customerId, JSON.stringify(updated));
	} catch (error) {
		return { customerId, status: 'failed', error: error.code, message: error.message };
	}
	return {
		customerId,
		status: 'settled',
		additionalBytes: aggregate.uploadBytes + aggregate.downloadBytes,
		uploadBytes: aggregate.uploadBytes,
		downloadBytes: aggregate.downloadBytes,
		settledUsedBytes: updated.settledUsedBytes,
		usageSettledThrough: updated.usageSettledThrough,
		usageRevision: updated.revision,
	};
}

// Settles one completed natural day. Throws on any day-level failure (SQL request
// error, malformed response). Row-level and definitive customer-level problems are
// reported but do not fail the day; temporary customer KV errors set `blocked` so the
// caller does not advance the global day cursor.
async function settleSettlementDay({ env, config, dayKey, fetchImpl, nowMs }) {
	const query = buildMembershipUsageDayQuery(config, dayKey, config.timezone);
	const rows = await queryAnalyticsEngineSql(fetchImpl, config, query);
	const dayStartMs = dayStartUtcMs(dayKey, config.timezone);

	const customers = new Map();
	const invalidRows = [];
	for (const row of rows) {
		try {
			const parsed = parseDayRow(row);
			if (!customers.has(parsed.customerId)) customers.set(parsed.customerId, parsed);
		} catch (error) {
			const rawCustomerId = row && typeof row === 'object'
				? (row.customerId ?? row.customer_id ?? (Array.isArray(row) ? row[0] : undefined))
				: undefined;
			invalidRows.push({ customerId: String(rawCustomerId ?? '(unknown)'), row, reason: error.code || 'unknown' });
		}
	}

	const results = await mapWithConcurrency([...customers.values()], config.concurrency, async entry => {
		return processDayCustomer({ env, customerId: entry.customerId, aggregate: entry, dayStartMs, nowMs });
	});
	const settled = results.filter(result => result.status === 'settled');
	const skipped = results.filter(result => result.status === 'skipped');
	const failed = results.filter(result => result.status === 'failed');
	const blocked = failed.length > 0;
	return {
		ok: true,
		day: dayKey,
		customers: settled.length,
		settled,
		skipped: [...skipped, ...invalidRows.map(row => ({ customerId: row.customerId, reason: row.reason }))],
		failed,
		blocked,
	};
}

async function runMembershipUsageSettlement(options = {}) {
	const env = options.env || {};
	const fetchImpl = options.fetchImpl === undefined
		? (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)
		: options.fetchImpl;
	const nowMs = Number.isSafeInteger(options.nowMs) && options.nowMs > 0 ? options.nowMs : Date.now();
	const logger = typeof options.logger === 'function'
		? options.logger
		: (message, level) => {
			if (level === 'error' || level === 'warn') console.warn(message);
			else console.log(message);
		};

	const config = getMembershipSettlementConfig(env);
	const validated = validateSettlementConfig(config);
	if (!validated.ok) return { ok: false, skipped: validated.reason };
	if (!fetchImpl) return { ok: false, error: 'fetch_unavailable' };
	if (!env.KV || typeof env.KV.get !== 'function' || typeof env.KV.put !== 'function') {
		return { ok: false, error: 'kv_unavailable' };
	}

	const todayKey = localDayKey(nowMs, config.timezone);
	let cursorDay;
	try {
		cursorDay = await kvGet(env, MEMBERSHIP_SETTLEMENT_CURSOR_KEY);
	} catch (error) {
		return { ok: false, error: 'cursor_get_failed' };
	}

	let days;
	let skippedDays;
	try {
		({ days, skippedDays } = planSettlementDays(cursorDay, todayKey, config.maxBackfillDays));
	} catch (error) {
		return { ok: false, error: error.code || 'invalid_cursor' };
	}
	if (days.length === 0) {
		return {
			ok: true,
			mode: 'daily-settlement',
			nowMs,
			today: todayKey,
			cursor: cursorDay || null,
			days: [],
			skippedDays,
			dayDetails: [],
			sqlQueries: 0,
			customers: 0,
			settledCustomers: 0,
			skippedCustomers: 0,
			failedCustomers: 0,
			kvWrites: 0,
		};
	}

	const dayResults = [];
	let sqlQueries = 0;
	for (const dayKey of days) {
		sqlQueries++;
		let dayResult;
		try {
			dayResult = await settleSettlementDay({ env, config, dayKey, fetchImpl, nowMs });
		} catch (error) {
			logger(`[membership-settlement] day ${dayKey} failed: ${error?.message || error}`, 'error');
			return {
				ok: false,
				error: error?.code || 'unknown',
				failedDay: dayKey,
				processedDays: dayResults,
				sqlQueries,
			};
		}
		if (dayResult.blocked) {
			logger(`[membership-settlement] day ${dayKey} blocked by ${dayResult.failed.length} customer KV error(s), cursor not advanced`, 'warn');
			return {
				ok: false,
				error: 'day_blocked_by_kv_errors',
				blockedDay: dayKey,
				blockedCustomers: dayResult.failed,
				dayDetails: [...dayResults, dayResult],
				sqlQueries,
			};
		}
		try {
			await kvPut(env, MEMBERSHIP_SETTLEMENT_CURSOR_KEY, dayKey);
		} catch (error) {
			logger(`[membership-settlement] cursor write failed for day ${dayKey}: ${error?.message || error}`, 'error');
			return {
				ok: false,
				error: 'cursor_put_failed',
				failedDay: dayKey,
				processedDays: dayResults,
				sqlQueries,
			};
		}
		dayResults.push(dayResult);
	}

	const settledCustomers = dayResults.reduce((sum, day) => sum + day.settled.length, 0);
	const skippedCustomers = dayResults.reduce((sum, day) => sum + day.skipped.length, 0);
	const failedCustomers = dayResults.reduce((sum, day) => sum + day.failed.length, 0);
	logger(`[membership-settlement] done: days=${dayResults.length} settled=${settledCustomers} skipped=${skippedCustomers} failed=${failedCustomers}`, 'info');
	return {
		ok: true,
		mode: 'daily-settlement',
		nowMs,
		today: todayKey,
		cursor: days[days.length - 1],
		days: days.map(day => day),
		skippedDays,
		dayDetails: dayResults,
		sqlQueries,
		customers: settledCustomers + skippedCustomers + failedCustomers,
		settledCustomers,
		skippedCustomers,
		failedCustomers,
		kvWrites: settledCustomers + dayResults.length,
	};
}

// ---------------------------------------------------------------- frequency policy

// Fixed 12-hour buckets in Asia/Shanghai (fixed UTC+8, no DST). Local 00:00 equals
// the previous day 16:00 UTC, so every bucket boundary is at UTC 16:00 or 04:00.
// This module deliberately reuses the existing "usage-v1" policy version constant so
// the frequency query reads the same data points as the daily settlement query.
const FREQUENCY_BUCKET_HOURS = 12;
const FREQUENCY_BUCKET_MS = FREQUENCY_BUCKET_HOURS * 3600 * 1000;
const SHANGHAI_MIDNIGHT_UTC_OFFSET_MS = 16 * 3600 * 1000;

// Start (UTC ms) of the Asia/Shanghai 12-hour bucket containing `nowMs`.
function frequencyBucketStartMs(nowMs) {
	if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw sqlError('invalid_time', 'Invalid timestamp for frequency bucket');
	const shifted = nowMs - SHANGHAI_MIDNIGHT_UTC_OFFSET_MS;
	const index = Math.floor(shifted / FREQUENCY_BUCKET_MS);
	return index * FREQUENCY_BUCKET_MS + SHANGHAI_MIDNIGHT_UTC_OFFSET_MS;
}

// Exclusive end (UTC ms) of the newest fully closed 12-hour bucket that is at least
// `closedBucketDelayHours` old. The in-progress bucket is never included.
function getLatestClosedBucketEnd(nowMs, closedBucketDelayHours = 0) {
	if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw sqlError('invalid_time', 'Invalid timestamp for closed bucket');
	if (!Number.isFinite(closedBucketDelayHours) || closedBucketDelayHours < 0) {
		throw sqlError('invalid_policy', 'closedBucketDelayHours must be non-negative');
	}
	const delayMs = Math.floor(closedBucketDelayHours * 3600 * 1000);
	let end = frequencyBucketStartMs(nowMs);
	while (nowMs - end < delayMs) end -= FREQUENCY_BUCKET_MS;
	return end;
}

function parseFrequencySettlementPolicy(rawJson) {
	let parsed;
	if (typeof rawJson === 'string' && rawJson.trim() !== '') {
		try {
			parsed = JSON.parse(rawJson);
		} catch (_) {
			return { ok: false, reason: 'invalid_json' };
		}
	} else if (rawJson && typeof rawJson === 'object') {
		parsed = rawJson;
	} else {
		return { ok: false, reason: 'missing_policy' };
	}

	const positiveInt = (value, fallback, max = 100000) => {
		const number = Number(value);
		return Number.isInteger(number) && number > 0 && number <= max ? number : fallback;
	};
	const nonNegativeInt = (value, fallback, max = 100000) => {
		const number = Number(value);
		return Number.isInteger(number) && number >= 0 && number <= max ? number : fallback;
	};
	const bucketMultiple = (value, fallback) => {
		const number = positiveInt(value, fallback);
		return number % FREQUENCY_BUCKET_HOURS === 0 ? number : null;
	};

	const timezone = typeof parsed.timezone === 'string' && parsed.timezone.trim()
		? parsed.timezone.trim()
		: 'Asia/Shanghai';
	if (timezone !== 'Asia/Shanghai') return { ok: false, reason: 'unsupported_timezone' };

	const bucketHours = Number(parsed.bucketHours);
	if (bucketHours !== FREQUENCY_BUCKET_HOURS) return { ok: false, reason: 'bucket_hours_not_12' };

	const highFrequencyThreshold = Number(parsed.highFrequencyThreshold);
	const mediumFrequencyThreshold = Number(parsed.mediumFrequencyThreshold);
	if (!Number.isInteger(highFrequencyThreshold) || highFrequencyThreshold < 0
		|| !Number.isInteger(mediumFrequencyThreshold) || mediumFrequencyThreshold < 0) {
		return { ok: false, reason: 'missing_connect_thresholds' };
	}
	if (highFrequencyThreshold <= mediumFrequencyThreshold) return { ok: false, reason: 'invalid_thresholds' };

	const highSettlementHours = bucketMultiple(parsed.highSettlementHours, 12);
	const mediumSettlementHours = bucketMultiple(parsed.mediumSettlementHours, 24);
	const lowSettlementHours = bucketMultiple(parsed.lowSettlementHours, 72);
	if (highSettlementHours === null || mediumSettlementHours === null || lowSettlementHours === null) {
		return { ok: false, reason: 'settlement_hours_not_bucket_multiple' };
	}

	const closedBucketDelayHours = nonNegativeInt(parsed.closedBucketDelayHours, 2, 168);
	const lookbackHours = positiveInt(parsed.lookbackHours, Math.max(lowSettlementHours + closedBucketDelayHours, 96), 100000);
	if (lookbackHours < lowSettlementHours + closedBucketDelayHours) return { ok: false, reason: 'lookback_too_small' };

	return {
		ok: true,
		policy: {
			bucketHours,
			cronIntervalHours: positiveInt(parsed.cronIntervalHours, 12, 168),
			frequencyWindowHours: positiveInt(parsed.frequencyWindowHours, 24, 168),
			highFrequencyThreshold,
			mediumFrequencyThreshold,
			highSettlementHours,
			mediumSettlementHours,
			lowSettlementHours,
			lookbackHours,
			closedBucketDelayHours,
			timezone,
		},
	};
}

// One unified GROUP BY query over every customer and every closed 12-hour bucket in the
// window. Connection count comes only from blob3 = 'connect'; traffic sums keep the
// Analytics sampling compensation (_sample_interval) and the local write-time weight
// (double3). The query never references UUIDs, tokens, names, targets or KV keys.
function buildFrequencyBucketQuery({ dataset, recordType = MEMBERSHIP_USAGE_RECORD_TYPE, policyVersion = MEMBERSHIP_USAGE_POLICY_VERSION }, windowStartMs, windowEndMs) {
	if (typeof dataset !== 'string' || !DATASET_PATTERN.test(dataset)) throw sqlError('invalid_dataset', 'Invalid Analytics Engine dataset name');
	if (!Number.isSafeInteger(windowStartMs) || !Number.isSafeInteger(windowEndMs) || windowEndMs <= windowStartMs) {
		throw sqlError('invalid_window', 'Invalid frequency query window');
	}
	const fromSec = Math.floor(windowStartMs / 1000);
	const toSec = Math.floor(windowEndMs / 1000);
	const bucketSeconds = FREQUENCY_BUCKET_HOURS * 3600;
	const offsetSeconds = Math.floor(SHANGHAI_MIDNIGHT_UTC_OFFSET_MS / 1000);
	return [
		'SELECT',
		'  index1 AS customerId,',
		`  intDiv(toUInt32(timestamp) - ${offsetSeconds}, ${bucketSeconds}) AS bucketIndex,`,
		'  SUM(_sample_interval * double1 * double3) AS uploadBytes,',
		'  SUM(_sample_interval * double2 * double3) AS downloadBytes,',
		"  sumIf(_sample_interval * double4, blob3 = 'connect') AS connectCount,",
		'  MAX(timestamp) AS latestEventTs',
		`FROM ${dataset}`,
		`WHERE blob1 = '${recordType}'`,
		`  AND blob2 = '${MEMBERSHIP_USAGE_TRANSPORT}'`,
		`  AND blob4 = '${policyVersion}'`,
		`  AND timestamp >= toDateTime(${fromSec})`,
		`  AND timestamp < toDateTime(${toSec})`,
		'GROUP BY index1, bucketIndex',
	].join('\n');
}

// Converts the SQL rows (one per customer per bucket) into JS bucket records with
// absolute UTC bucket boundaries and milliseconds.
function parseFrequencyBucketRows(rows) {
	if (!Array.isArray(rows)) throw sqlError('sql_data_invalid', 'Frequency bucket rows must be an array');
	const buckets = [];
	for (const rawRow of rows) {
		try {
			const row = normalizeRow(rawRow);
			if (!row) continue;
			const customerId = row.customerId;
			if (typeof customerId !== 'string' || !CUSTOMER_ID_PATTERN.test(customerId)) continue;
			const bucketIndex = toFiniteNonNegative(row.bucketIndex, 'bucketIndex');
			if (!Number.isSafeInteger(bucketIndex)) continue;
			const uploadBytes = Math.round(toFiniteNonNegative(row.uploadBytes, 'uploadBytes'));
			const downloadBytes = Math.round(toFiniteNonNegative(row.downloadBytes, 'downloadBytes'));
			if (!Number.isSafeInteger(uploadBytes) || !Number.isSafeInteger(downloadBytes)) continue;
			const connectCount = toFiniteNonNegative(row.connectCount, 'connectCount');
			const latestEventTs = toFiniteNonNegative(row.latestEventTs, 'latestEventTs');
			buckets.push({
				customerId,
				bucketStartMs: bucketIndex * FREQUENCY_BUCKET_MS + SHANGHAI_MIDNIGHT_UTC_OFFSET_MS,
				bucketEndMs: (bucketIndex + 1) * FREQUENCY_BUCKET_MS + SHANGHAI_MIDNIGHT_UTC_OFFSET_MS,
				uploadBytes,
				downloadBytes,
				connectCount,
				latestEventMs: Math.round(latestEventTs * 1000),
			});
		} catch (_) {
			// Malformed rows are skipped conservatively so one bad row cannot fail the run.
		}
	}
	return buckets;
}

// Frequency tier classification. High frequency only shortens the settlement interval;
// it never disables a customer or changes their status.
function classifyCustomerFrequency(connectsInWindow, policy) {
	if (!policy || !Number.isSafeInteger(policy.highFrequencyThreshold) || !Number.isSafeInteger(policy.mediumFrequencyThreshold)) {
		throw sqlError('invalid_policy', 'Frequency thresholds are required');
	}
	if (!Number.isFinite(connectsInWindow) || connectsInWindow < 0) throw sqlError('invalid_aggregate', 'Invalid connect count');
	if (connectsInWindow >= policy.highFrequencyThreshold) {
		return { tier: 'high', settlementIntervalHours: policy.highSettlementHours };
	}
	if (connectsInWindow >= policy.mediumFrequencyThreshold) {
		return { tier: 'medium', settlementIntervalHours: policy.mediumSettlementHours };
	}
	return { tier: 'low', settlementIntervalHours: policy.lowSettlementHours };
}

// Groups buckets per customer, computes the connect count over the configured frequency
// window and returns the tier. Pure computation: no KV reads or writes, no status
// changes. "Is the customer due for settlement" is deliberately left to phase 3.
function aggregateCustomerFrequencyWindow(rows, policy, nowMs) {
	if (!policy || !Number.isSafeInteger(nowMs) || nowMs < 0) throw sqlError('invalid_policy', 'Invalid frequency policy or timestamp');
	const buckets = Array.isArray(rows) ? rows : parseFrequencyBucketRows(rows);
	const byCustomer = new Map();
	for (const bucket of buckets) {
		if (!byCustomer.has(bucket.customerId)) byCustomer.set(bucket.customerId, []);
		byCustomer.get(bucket.customerId).push(bucket);
	}
	const windowStartMs = nowMs - policy.frequencyWindowHours * 3600 * 1000;
	const results = [];
	for (const [customerId, customerBuckets] of byCustomer) {
		let connectsInWindow = 0;
		let latestEventMs = 0;
		for (const bucket of customerBuckets) {
			if (bucket.bucketEndMs > windowStartMs) connectsInWindow += Number.isFinite(bucket.connectCount) ? bucket.connectCount : 0;
			if (bucket.latestEventMs > latestEventMs) latestEventMs = bucket.latestEventMs;
		}
		const tier = classifyCustomerFrequency(connectsInWindow, policy);
		results.push({
			customerId,
			frequencyTier: tier.tier,
			settlementIntervalHours: tier.settlementIntervalHours,
			connectsInWindow,
			latestEventMs,
			buckets: customerBuckets.slice().sort((a, b) => a.bucketStartMs - b.bucketStartMs),
		});
	}
	return results.sort((a, b) => a.customerId.localeCompare(b.customerId));
}

// End (UTC ms) of the 12-hour bucket that is currently in progress at `nowMs`.
function getCurrentFrequencyBucketEnd(nowMs) {
	return frequencyBucketStartMs(nowMs) + FREQUENCY_BUCKET_MS;
}

function isValidBucketBoundaryMs(ms) {
	return Number.isSafeInteger(ms) && ms >= 0 && (ms - SHANGHAI_MIDNIGHT_UTC_OFFSET_MS) % FREQUENCY_BUCKET_MS === 0;
}

// Per-customer step of the frequency-layered runner. At most one KV get and, when due,
// at most one KV put. Watermark edge cases are handled conservatively (see the report
// and the test suite): invalid watermarks are skipped rather than cutting buckets.
async function processFrequencyCustomer({ env, entry, cutoffMs, windowStartMs, nowMs }) {
	const customerId = entry.customerId;
	let raw;
	try {
		raw = await kvGet(env, MEMBERSHIP_USAGE_KEY_PREFIX + customerId);
	} catch (error) {
		return { customerId, status: 'failed', error: error.code, message: error.message };
	}
	if (raw === null || raw === undefined) return { customerId, status: 'skipped', reason: 'missing_usage' };
	let usage;
	try {
		usage = parseUsageRecord(raw);
	} catch (error) {
		return { customerId, status: 'skipped', reason: error.code || 'invalid_usage_record', message: error.message };
	}

	// Case 2/3: zero watermark.
	if (usage.usageSettledThrough === 0) {
		if (usage.settledUsedBytes === 0) {
			const earliestStartMs = entry.buckets.length > 0 ? entry.buckets[0].bucketStartMs : null;
			if (!Number.isSafeInteger(earliestStartMs)) return { customerId, status: 'skipped', reason: 'no_closed_buckets' };
			usage = { ...usage, usageSettledThrough: earliestStartMs };
		} else {
			return { customerId, status: 'skipped', reason: 'missing_watermark_with_existing_usage' };
		}
	}
	// Non-boundary watermark: conservative skip, never cut a bucket arbitrarily.
	if (!isValidBucketBoundaryMs(usage.usageSettledThrough)) {
		return { customerId, status: 'skipped', reason: 'invalid_watermark' };
	}
	// Case 5: already settled through (or beyond) this cutoff.
	if (usage.usageSettledThrough >= cutoffMs) {
		return { customerId, status: 'skipped', reason: 'already_settled' };
	}
	// Case 4: watermark older than the lookback window; settling now would lose old data.
	if (usage.usageSettledThrough < windowStartMs) {
		return { customerId, status: 'skipped', reason: 'watermark_before_lookback' };
	}

	const elapsedHours = (cutoffMs - usage.usageSettledThrough) / 3600000;
	if (elapsedHours < entry.settlementIntervalHours) {
		return {
			customerId,
			status: 'not_due',
			tier: entry.frequencyTier,
			settlementIntervalHours: entry.settlementIntervalHours,
			elapsedHours,
		};
	}

	let uploadBytes = 0, downloadBytes = 0;
	for (const bucket of entry.buckets) {
		if (bucket.bucketEndMs > usage.usageSettledThrough && bucket.bucketEndMs <= cutoffMs) {
			uploadBytes += bucket.uploadBytes;
			downloadBytes += bucket.downloadBytes;
		}
	}
	if (!Number.isSafeInteger(uploadBytes) || !Number.isSafeInteger(downloadBytes)) {
		return { customerId, status: 'skipped', reason: 'bucket_bytes_overflow' };
	}
	let updated;
	try {
		updated = computeMembershipUsageSettlement(usage, { uploadBytes, downloadBytes }, cutoffMs, nowMs);
	} catch (error) {
		return { customerId, status: 'skipped', reason: error.code || 'invalid_record', message: error.message };
	}
	try {
		await kvPut(env, MEMBERSHIP_USAGE_KEY_PREFIX + customerId, JSON.stringify(updated));
	} catch (error) {
		return { customerId, status: 'failed', error: error.code, message: error.message };
	}
	return {
		customerId,
		status: 'settled',
		tier: entry.frequencyTier,
		addedBytes: uploadBytes + downloadBytes,
		uploadBytes,
		downloadBytes,
		settledUsedBytes: updated.settledUsedBytes,
		usageSettledThrough: updated.usageSettledThrough,
		quotaExceeded: updated.quotaExceeded,
	};
}

// Frequency-layered settlement runner. One unified Analytics SQL per run; per customer at
// most one KV get and, when due, at most one KV put. Not wired into any scheduled handler
// yet: it is exported for tests and for the phase-4 standalone worker.
async function runFrequencyLayeredSettlement(options = {}) {
	const env = options.env || {};
	const fetchImpl = options.fetchImpl === undefined
		? (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)
		: options.fetchImpl;
	const nowMs = Number.isSafeInteger(options.nowMs) && options.nowMs > 0 ? options.nowMs : Date.now();
	const logger = typeof options.logger === 'function'
		? options.logger
		: (message, level) => {
			if (level === 'error' || level === 'warn') console.warn(message);
			else console.log(message);
		};

	const config = getMembershipSettlementConfig(env);
	const validated = validateSettlementConfig(config);
	if (!validated.ok) return { ok: false, skipped: validated.reason };
	if (!fetchImpl) return { ok: false, error: 'fetch_unavailable' };
	if (!env.KV || typeof env.KV.get !== 'function' || typeof env.KV.put !== 'function') {
		return { ok: false, error: 'kv_unavailable' };
	}
	const policyResult = parseFrequencySettlementPolicy(env.USAGE_SETTLEMENT_POLICY_JSON);
	if (!policyResult.ok) return { ok: false, skipped: policyResult.reason };
	const policy = policyResult.policy;

	const cutoffMs = getLatestClosedBucketEnd(nowMs, policy.closedBucketDelayHours);
	const windowStartMs = nowMs - policy.lookbackHours * 3600 * 1000;

	let rows;
	let queryCount = 0;
	try {
		const query = buildFrequencyBucketQuery(config, windowStartMs, cutoffMs);
		queryCount = 1;
		rows = await queryAnalyticsEngineSql(fetchImpl, config, query);
	} catch (error) {
		logger(`[membership-frequency-settlement] query failed: ${error?.message || error}`, 'error');
		return {
			ok: false,
			error: error?.code || 'sql_failed',
			queryCount,
			cutoffMs,
			windowStartMs,
			customerCount: 0,
			settledCount: 0,
			notDueCount: 0,
			skippedCount: 0,
			failedCount: 0,
			addedBytes: 0,
			results: [],
		};
	}

	let buckets;
	try {
		buckets = parseFrequencyBucketRows(rows);
	} catch (error) {
		return {
			ok: false,
			error: error?.code || 'sql_data_invalid',
			queryCount,
			cutoffMs,
			windowStartMs,
			customerCount: 0,
			settledCount: 0,
			notDueCount: 0,
			skippedCount: 0,
			failedCount: 0,
			addedBytes: 0,
			results: [],
		};
	}

	const aggregated = aggregateCustomerFrequencyWindow(buckets, policy, nowMs);
	const results = await mapWithConcurrency(aggregated, config.concurrency, async entry => {
		return processFrequencyCustomer({ env, entry, cutoffMs, windowStartMs, nowMs });
	});
	const settled = results.filter(result => result.status === 'settled');
	const notDue = results.filter(result => result.status === 'not_due');
	const skipped = results.filter(result => result.status === 'skipped');
	const failed = results.filter(result => result.status === 'failed');
	const addedBytes = settled.reduce((sum, result) => sum + (result.addedBytes || 0), 0);
	logger(`[membership-frequency-settlement] done: customers=${results.length} settled=${settled.length} notDue=${notDue.length} skipped=${skipped.length} failed=${failed.length}`, 'info');
	return {
		ok: true,
		mode: 'frequency-layered',
		nowMs,
		queryCount,
		customerCount: results.length,
		settledCount: settled.length,
		notDueCount: notDue.length,
		skippedCount: skipped.length,
		failedCount: failed.length,
		addedBytes,
		cutoffMs,
		windowStartMs,
		results,
	};
}

export {
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
	frequencyBucketStartMs,
	getLatestClosedBucketEnd,
	parseFrequencySettlementPolicy,
	buildFrequencyBucketQuery,
	parseFrequencyBucketRows,
	classifyCustomerFrequency,
	aggregateCustomerFrequencyWindow,
	getCurrentFrequencyBucketEnd,
	runFrequencyLayeredSettlement,
};
