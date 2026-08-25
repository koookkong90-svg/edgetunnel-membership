// 会员管理后台流量额度数据链路回归测试。
//
// 覆盖场景：
//   1. 创建客户（quotaGiB=100）正确写入 usage 记录 quotaBytes=100*1024^3
//   2. 已结算 0 GiB 时剩余流量为 100 GiB
//   3. 已结算 20 GiB 时剩余流量为 80 GiB
//   4. quotaBytes 缺失/null/字符串/非法值不能显示成空白 GiB
//   5. 无限流量客户显示“不限流量”
//   6. 列表与套餐详情（set-quota 响应）的总流量/已结算/剩余流量一致
//   7. 前端与后端流量字段名一致（quotaBytes/settledUsedBytes/remainingBytes，无 GiB 单位字段）
//   8. 旧 schema（v2/v3/缺失 usage/非法 usage）兼容或明确跳过
//
// 直接加载仓库内真实模块（_worker.js 的 fetch 处理器 + admin-members.js 页面脚本），
// 全程使用内存 KV mock，不触碰任何真实 Cloudflare 资源。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const GIB = 1024 ** 3;

// Node 的 WebCrypto 不支持 MD5，而 _worker.js 的 MD5MD5（双重 MD5）依赖它。
// 在动态导入 _worker.js 之前给 globalThis.crypto.subtle 打补丁。
const originalSubtle = globalThis.crypto?.subtle;
if (originalSubtle) {
	const patchedDigest = async (algorithm, data) => {
		const name = typeof algorithm === 'string' ? algorithm : algorithm?.name;
		if (name === 'MD5') {
			return crypto.createHash('md5').update(new Uint8Array(data)).digest();
		}
		return originalSubtle.digest(algorithm, data);
	};
	const patchedSubtle = new Proxy(originalSubtle, {
		get: (target, prop) => {
			if (prop === 'digest') return patchedDigest;
			const value = target[prop];
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
	const patchedCrypto = new Proxy(globalThis.crypto, {
		get: (target, prop) => {
			if (prop === 'subtle') return patchedSubtle;
			const value = target[prop];
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
	Object.defineProperty(globalThis, 'crypto', { value: patchedCrypto, configurable: true, writable: true });
}

const workerModule = await import('../_worker.js');
const worker = workerModule.default;
const adminModule = await import('../admin-members.js');

const ADMIN = 'regression-admin-password';
const KEY = 'regression-key-password';
const UA = 'edgetunnel-regression-test';
const ORIGIN = 'https://magic-membership-prod.pages.dev';

// 与 _worker.js 中 MD5MD5 一致：hex(MD5(hex(MD5(text)).slice(7, 27)))
function md5md5(text) {
	const first = crypto.createHash('md5').update(text).digest('hex');
	return crypto.createHash('md5').update(first.slice(7, 27)).digest('hex');
}

const AUTH_COOKIE = md5md5(UA + KEY + ADMIN);

function makeKv() {
	const store = new Map();
	return {
		_store: store,
		async get(key) {
			return store.has(key) ? store.get(key) : null;
		},
		async put(key, value) {
			store.set(key, String(value));
		},
		async delete(key) {
			store.delete(key);
		},
		async list(options = {}) {
			const prefix = options.prefix || '';
			const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
			return { keys: keys.map((name) => ({ name })), list_complete: true, cursor: null };
		},
	};
}

function makeEnv(kv) {
	return { ADMIN, KEY, KV: kv, MEMBERSHIP_MODE: 'hybrid', DEBUG: 'false' };
}

function adminRequest(urlPath, { method = 'GET', body, headers = {} } = {}) {
	const init = {
		method,
		headers: { 'User-Agent': UA, Cookie: `auth=${AUTH_COOKIE}`, ...headers },
	};
	if (body !== undefined) {
		init.headers['Content-Type'] = 'application/json';
		init.headers['Origin'] = ORIGIN;
		init.headers['X-Admin-Request'] = '1';
		init.body = typeof body === 'string' ? body : JSON.stringify(body);
	}
	const real = new Request(ORIGIN + urlPath, init);
	// Worker 顶层代码访问 request.cf.colo，Node 的 Request 没有 cf 字段。
	return new Proxy(real, {
		get: (target, prop) => (prop === 'cf' ? { colo: 'test', asn: 0, country: 'US' } : target[prop]),
	});
}

async function apiCall(kv, urlPath, options) {
	const env = makeEnv(kv);
	const response = await worker.fetch(adminRequest(urlPath, options), env, { waitUntil() {} });
	const payload = await response.json();
	return { status: response.status, payload };
}

async function createCustomer(kv, trafficPlan) {
	const idempotencyKey = 'test-' + crypto.randomBytes(12).toString('hex');
	const { status, payload } = await apiCall(kv, '/admin/api/customers', {
		method: 'POST',
		body: { name: '测试客户', remark: '', durationDays: 30, ...trafficPlan, idempotencyKey },
	});
	assert.equal(status, 201, `create should return 201, got ${status}: ${JSON.stringify(payload)}`);
	return {
		customerId: payload.customer.customerId,
		revision: payload.customer.revision,
		usageRevision: payload.customer.usageRevision,
	};
}

function usageRecord(kv, customerId) {
	const raw = kv._store.get('membership:usage:' + customerId);
	assert.ok(raw, 'usage record missing for ' + customerId);
	return JSON.parse(raw);
}

function seedCustomer(kv, { customerId, quotaBytes = 100 * GIB, settledUsedBytes = 0, unlimitedTraffic = false, uuidSuffix = '0' }) {
	const uuid = `00000000-0000-4000-8000-${String(uuidSuffix).padStart(12, '0')}`;
	const now = Date.now();
	kv._store.set(
		'membership:customer:' + customerId,
		JSON.stringify({
			schemaVersion: 4,
			kind: 'membership-customer',
			customerId,
			name: '种子客户',
			remark: '',
			uuid,
			tokenHash: crypto.createHash('sha256').update(customerId).digest('hex'),
			tokenPreview: '••••abcd',
			state: 'active',
			enabled: true,
			expiresAt: now + 30 * 86400000,
			createdAt: now - 1000,
			updatedAt: now,
			revision: 1,
			disableReason: null,
		}),
	);
	kv._store.set(
		'membership:usage:' + customerId,
		JSON.stringify({
			schemaVersion: 4,
			kind: 'membership-usage',
			customerId,
			quotaBytes: unlimitedTraffic ? null : quotaBytes,
			settledUsedBytes,
			quotaExceeded: unlimitedTraffic === false && settledUsedBytes >= quotaBytes,
			usageUpdatedAt: 0,
			usageSettledThrough: 0,
			unlimitedTraffic,
			revision: 1,
		}),
	);
}

// ---------------- 前端显示逻辑（取自真实 admin-members.js 页面脚本） ----------------

function extractBlock(source, marker) {
	const start = source.indexOf(marker);
	assert.ok(start >= 0, `marker not found: ${marker}`);
	const bodyStart = source.indexOf('{', start);
	let depth = 0;
	let inStr = null;
	for (let i = bodyStart; i < source.length; i += 1) {
		const ch = source[i];
		if (inStr) {
			if (ch === '\\') i += 1;
			else if (ch === inStr) inStr = null;
		} else if (ch === '"' || ch === "'" || ch === '`') {
			inStr = ch;
		} else if (ch === '{') {
			depth += 1;
		} else if (ch === '}') {
			depth -= 1;
			if (depth === 0) return source.slice(start, i + 1);
		}
	}
	throw new Error(`unbalanced block for marker: ${marker}`);
}

let frontendPromise = null;
function getFrontend() {
	if (!frontendPromise) {
		frontendPromise = (async () => {
			// 必须从“渲染后的页面”提取内联脚本：admin-members.js 的脚本位于 HTML 模板字符串中，
			// 模板求值会处理反斜杠转义（如 /\.0+$/ 会被改写为 /.0+$/）。直接读源文件无法捕获此类问题。
			const response = adminModule.renderAdminMembersPage();
			const html = await response.text();
			const scriptMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
			assert.ok(scriptMatch, 'inline admin script not found');
			const scriptSource = scriptMatch[1];
			const chunks = [
				scriptSource.match(/const DAY_MS[^;]*;/)[0],
				extractBlock(scriptSource, 'function isPlainObject(value)'),
				extractBlock(scriptSource, 'function hasExactFields(value, fields)'),
				extractBlock(scriptSource, 'function isValidCustomerTimestamp(value)'),
				extractBlock(scriptSource, 'function formatTrafficBytes(value)'),
				extractBlock(scriptSource, 'function validateCustomer(value)'),
				'globalThis.__fmt = formatTrafficBytes; globalThis.__validate = validateCustomer;',
			];
			const sandbox = vm.createContext({ Date, Number, Object, Array, RegExp, Math, String, Boolean, console });
			vm.runInContext(chunks.join('\n'), sandbox);
			return {
				scriptSource,
				formatTrafficBytes: (value) => vm.runInContext('__fmt(' + JSON.stringify(value) + ')', sandbox),
				validateCustomer: (customer) => vm.runInContext('__validate(' + JSON.stringify(customer) + ')', sandbox),
			};
		})();
	}
	return frontendPromise;
}

function makeCustomerPayload(overrides = {}) {
	const quotaBytes = overrides.quotaBytes ?? 100 * GIB;
	const settledUsedBytes = overrides.settledUsedBytes ?? 0;
	const unlimitedTraffic = overrides.unlimitedTraffic ?? false;
	return {
		customerId: 'cus_TestTestTestTestTestTest1',
		name: '测试客户',
		remark: '',
		uuid: '3f2a1b4c-5d6e-4f80-9a1b-2c3d4e5f6071',
		state: 'active',
		enabled: true,
		expiresAt: Date.now() + 30 * 86400000,
		createdAt: Date.now() - 1000,
		updatedAt: Date.now(),
		revision: 1,
		usageRevision: 1,
		tokenPreview: '••••abcd',
		quotaBytes: unlimitedTraffic ? null : quotaBytes,
		settledUsedBytes,
		remainingBytes: unlimitedTraffic ? null : Math.max(0, quotaBytes - settledUsedBytes),
		quotaExceeded: unlimitedTraffic === false && settledUsedBytes >= quotaBytes,
		usageUpdatedAt: 0,
		usageSettledThrough: 0,
		unlimitedTraffic,
		disableReason: null,
		trafficEligible: unlimitedTraffic || settledUsedBytes < quotaBytes,
		expired: false,
		...overrides,
	};
}

// 与 admin-members.js 中列表/套餐面板的单元格三元表达式一致。
async function totalCell(customer) {
	const fe = await getFrontend();
	const validated = fe.validateCustomer(customer);
	return validated.trafficInvalid ? '流量异常' : validated.unlimitedTraffic ? '不限流量' : fe.formatTrafficBytes(validated.quotaBytes);
}
async function usedCell(customer) {
	const fe = await getFrontend();
	const validated = fe.validateCustomer(customer);
	return validated.trafficInvalid ? '流量异常' : fe.formatTrafficBytes(validated.settledUsedBytes);
}
async function remainingCell(customer) {
	const fe = await getFrontend();
	const validated = fe.validateCustomer(customer);
	return validated.trafficInvalid ? '流量异常' : validated.unlimitedTraffic ? '不限流量' : fe.formatTrafficBytes(validated.remainingBytes);
}

// ---------------- 测试 ----------------

test('创建 100 GiB 客户：usage 记录正确写入 quotaBytes（创建链路）', async () => {
	const kv = makeKv();
	const created = await createCustomer(kv, { quotaGiB: 100 });
	const usage = usageRecord(kv, created.customerId);
	assert.equal(usage.schemaVersion, 4);
	assert.equal(usage.kind, 'membership-usage');
	assert.equal(usage.quotaBytes, 100 * GIB);
	assert.equal(usage.settledUsedBytes, 0);
	assert.equal(usage.unlimitedTraffic, false);
	assert.equal(usage.quotaExceeded, false);
});

test('已结算 0 GiB 时剩余流量为 100 GiB（列表 API）', async () => {
	const kv = makeKv();
	const created = await createCustomer(kv, { quotaGiB: 100 });
	const { payload } = await apiCall(kv, '/admin/api/customers');
	const item = payload.items.find((c) => c.customerId === created.customerId);
	assert.ok(item, 'created customer must appear in list');
	assert.equal(item.quotaBytes, 100 * GIB);
	assert.equal(item.settledUsedBytes, 0);
	assert.equal(item.remainingBytes, 100 * GIB);
	assert.equal(item.trafficEligible, true);
});

test('已结算 20 GiB 时剩余流量为 80 GiB（set-used-traffic）', async () => {
	const kv = makeKv();
	const created = await createCustomer(kv, { quotaGiB: 100 });
	const { payload } = await apiCall(kv, `/admin/api/customers/${created.customerId}/set-used-traffic`, {
		method: 'POST',
		body: { usedGiB: 20, expectedUsageRevision: created.usageRevision },
	});
	assert.equal(payload.customer.settledUsedBytes, 20 * GIB);
	assert.equal(payload.customer.remainingBytes, 80 * GIB);
	const { payload: listPayload } = await apiCall(kv, '/admin/api/customers');
	const item = listPayload.items.find((c) => c.customerId === created.customerId);
	assert.equal(item.settledUsedBytes, 20 * GIB);
	assert.equal(item.remainingBytes, 80 * GIB);
});

test('列表与套餐详情（set-quota 响应）的总流量/已结算/剩余流量一致', async () => {
	const kv = makeKv();
	const created = await createCustomer(kv, { quotaGiB: 100 });
	const { payload: packagePayload } = await apiCall(kv, `/admin/api/customers/${created.customerId}/quota`, {
		method: 'POST',
		body: { quotaGiB: 200, expectedRevision: created.revision },
	});
	const detail = packagePayload.customer;
	assert.equal(detail.quotaBytes, 200 * GIB);
	const { payload: listPayload } = await apiCall(kv, '/admin/api/customers');
	const item = listPayload.items.find((c) => c.customerId === created.customerId);
	for (const field of ['quotaBytes', 'settledUsedBytes', 'remainingBytes', 'quotaExceeded', 'trafficEligible']) {
		assert.equal(detail[field], item[field], `field ${field} must match between package detail and list`);
	}
});

test('无限流量客户：usage 写入 null 额度，列表与前端显示“不限流量”', async () => {
	const kv = makeKv();
	const created = await createCustomer(kv, { unlimitedTraffic: true });
	const usage = usageRecord(kv, created.customerId);
	assert.equal(usage.quotaBytes, null);
	assert.equal(usage.unlimitedTraffic, true);
	const { payload } = await apiCall(kv, '/admin/api/customers');
	const item = payload.items.find((c) => c.customerId === created.customerId);
	assert.equal(item.quotaBytes, null);
	assert.equal(item.remainingBytes, null);
	assert.equal(item.trafficEligible, true);
	assert.equal(await totalCell(item), '不限流量');
	assert.equal(await remainingCell(item), '不限流量');
});

test('formatTrafficBytes 对合法/非法值输出正确，绝不产生空白数字', async () => {
	const { formatTrafficBytes } = await getFrontend();
	assert.equal(formatTrafficBytes(0), '0 GiB');
	assert.equal(formatTrafficBytes(1 * GIB), '1 GiB');
	assert.equal(formatTrafficBytes(100 * GIB), '100 GiB');
	assert.equal(formatTrafficBytes(200 * GIB), '200 GiB');
	for (const bad of [undefined, null, -1, 1.5, '107374182400']) {
		assert.equal(formatTrafficBytes(bad), '流量异常', `bad value: ${String(bad)}`);
	}
});

test('渲染后脚本的 formatTrafficBytes 正则保持转义（200/100/0 GiB 完整可见）', async () => {
	const { scriptSource, formatTrafficBytes } = await getFrontend();
	assert.ok(/\/\\\.0\+\$\//.test(scriptSource), 'rendered script must keep the escaped-dot regex /\\\\.0+$/');
	assert.ok(!/\/\.0\+\$\//.test(scriptSource), 'rendered script must not contain the unescaped-dot regex /.0+$/');
	assert.equal(formatTrafficBytes(200 * GIB), '200 GiB');
	assert.equal(formatTrafficBytes(100 * GIB), '100 GiB');
	assert.equal(formatTrafficBytes(0), '0 GiB');
});

test('列表与套餐详情的流量单元格无 CSS 裁切规则（桌面与窄屏）', async () => {
	const html = await (await adminModule.renderAdminMembersPage()).text();
	const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/);
	assert.ok(styleMatch, 'style block not found');
	const css = styleMatch[1];
	// 桌面：表格容器横向滚动而非裁切，单元格无 overflow/text-overflow/nowrap。
	assert.ok(/\.table-wrap\s*\{[^}]*overflow-x:\s*auto/.test(css), 'table-wrap must scroll horizontally');
	assert.ok(/table\s*\{[^}]*min-width:\s*1280px/.test(css), 'table must keep min-width so narrow screens scroll');
	assert.ok(!/td\s*\{[^}]*overflow:\s*hidden/.test(css), 'td must not clip');
	assert.ok(!/td\s*\{[^}]*text-overflow/.test(css), 'td must not use text-overflow');
	assert.ok(!/td\s*\{[^}]*white-space:\s*nowrap/.test(css), 'td must not force nowrap');
	assert.ok(!/\.secret-value\s*\{[^}]*overflow:\s*hidden/.test(css), 'package values must not clip');
	// 窄屏媒体块：thead 的裁切只作用于表头，td 值列不得裁切。
	const mobile = css.match(/@media \(max-width:760px\)\s*\{([\s\S]*?)\n\t\t\}/);
	assert.ok(mobile, 'mobile media block not found');
	assert.ok(!/td\s*\{[^}]*overflow:\s*hidden/.test(mobile[1]), 'mobile td must not clip');
	assert.ok(!/td\s*\{[^}]*text-overflow/.test(mobile[1]), 'mobile td must not use text-overflow');
});

test('quotaBytes 缺失/null/字符串/非法值不能显示成空白 GiB', async () => {
	const { validateCustomer } = await getFrontend();
	// 字段完全缺失：前端显式抛错（invalid_response），页面显示“数据格式异常”，绝不渲染空白 GiB。
	const missing = makeCustomerPayload({ quotaBytes: undefined });
	assert.throws(() => validateCustomer(missing), /invalid_response/);
	// 字段存在但值非法：trafficInvalid=true，显示“流量异常”，绝不渲染空白 GiB。
	const cases = [
		{ name: 'null', quotaBytes: null },
		{ name: 'string', quotaBytes: '107374182400' },
		{ name: 'zero', quotaBytes: 0 },
		{ name: 'negative', quotaBytes: -1 },
		{ name: 'float', quotaBytes: 1.5 },
	];
	for (const { name, quotaBytes } of cases) {
		const payload = makeCustomerPayload({ quotaBytes });
		const cell = await totalCell(payload);
		assert.notEqual(cell, ' GiB', name);
		assert.notEqual(cell, '', name);
		assert.ok(!/^\s*GiB$/.test(cell), name);
		assert.equal(cell, '流量异常', name);
	}
});

test('正式 KV 记录形态（200 GiB / 100 GiB、已结算 0 GiB）经列表与前端显示为数字', async () => {
	const kv = makeKv();
	seedCustomer(kv, { customerId: 'cus_ProdShapeAAAAAAAAAAAAAAA1', quotaBytes: 200 * GIB });
	seedCustomer(kv, { customerId: 'cus_ProdShapeAAAAAAAAAAAAAAA2', quotaBytes: 100 * GIB });
	const { payload } = await apiCall(kv, '/admin/api/customers');
	const a = payload.items.find((c) => c.customerId === 'cus_ProdShapeAAAAAAAAAAAAAAA1');
	const b = payload.items.find((c) => c.customerId === 'cus_ProdShapeAAAAAAAAAAAAAAA2');
	assert.ok(a && b);
	assert.equal(await totalCell(a), '200 GiB');
	assert.equal(await usedCell(a), '0 GiB');
	assert.equal(await remainingCell(a), '200 GiB');
	assert.equal(await totalCell(b), '100 GiB');
	assert.equal(await remainingCell(b), '100 GiB');
});

test('前端与后端流量字段名一致（无 GiB 单位字段漂移）', async () => {
	const workerSource = fs.readFileSync(path.join(REPO_ROOT, '_worker.js'), 'utf8');
	const detailMatch = workerSource.match(/function toCustomerDetail\(customer\) \{[\s\S]*?return \{([\s\S]*?)\n\s*\};/);
	assert.ok(detailMatch, 'toCustomerDetail return block not found');
	const backendFields = [...detailMatch[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1]);

	const frontendSource = (await getFrontend()).scriptSource;
	const requiredMatch = frontendSource.match(/const requiredFields = \[([^\]]*)\]/);
	assert.ok(requiredMatch, 'frontend requiredFields not found');
	const frontendFields = [...requiredMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);

	for (const field of ['quotaBytes', 'settledUsedBytes', 'remainingBytes', 'unlimitedTraffic', 'quotaExceeded', 'trafficEligible']) {
		assert.ok(backendFields.includes(field), `backend must return ${field}`);
		assert.ok(frontendFields.includes(field), `frontend must read ${field}`);
	}
	for (const legacy of ['quotaGiB', 'usedGiB', 'remainingGiB']) {
		assert.ok(!backendFields.includes(legacy), `backend must not expose ${legacy}`);
		assert.ok(!frontendFields.includes(legacy), `frontend must not read ${legacy}`);
	}
});

test('旧 schema（v2 / 缺失 usage / 非法 usage）兼容或明确跳过，不产生空白显示', async () => {
	const kv = makeKv();
	const now = Date.now();

	const v2Id = 'cus_OldV2AAAAAAAAAAAAAAAAAAAA';
	kv._store.set(
		'membership:customer:' + v2Id,
		JSON.stringify({
			schemaVersion: 2,
			customerId: v2Id,
			name: '旧v2客户',
			remark: '',
			uuid: '00000000-0000-4000-8000-000000000001',
			tokenHash: 'a'.repeat(64),
			tokenPreview: '••••aaaa',
			state: 'active',
			enabled: true,
			expiresAt: now + 86400000,
			createdAt: now - 1000,
			updatedAt: now,
			revision: 3,
		}),
	);

	const noUsageId = 'cus_NoUsageAAAAAAAAAAAAAAAAAA';
	kv._store.set(
		'membership:customer:' + noUsageId,
		JSON.stringify({
			schemaVersion: 4,
			kind: 'membership-customer',
			customerId: noUsageId,
			name: '无usage客户',
			remark: '',
			uuid: '00000000-0000-4000-8000-000000000002',
			tokenHash: 'b'.repeat(64),
			tokenPreview: '••••bbbb',
			state: 'active',
			enabled: true,
			expiresAt: now + 86400000,
			createdAt: now - 1000,
			updatedAt: now,
			revision: 1,
			disableReason: null,
		}),
	);

	const invalidId = 'cus_InvalidUsageAAAAAAAAAAAAA';
	kv._store.set(
		'membership:customer:' + invalidId,
		JSON.stringify({
			schemaVersion: 4,
			kind: 'membership-customer',
			customerId: invalidId,
			name: '非法usage客户',
			remark: '',
			uuid: '00000000-0000-4000-8000-000000000003',
			tokenHash: 'c'.repeat(64),
			tokenPreview: '••••cccc',
			state: 'active',
			enabled: true,
			expiresAt: now + 86400000,
			createdAt: now - 1000,
			updatedAt: now,
			revision: 1,
			disableReason: null,
		}),
	);
	kv._store.set(
		'membership:usage:' + invalidId,
		JSON.stringify({
			schemaVersion: 4,
			kind: 'membership-usage',
			customerId: invalidId,
			quotaBytes: 'not-a-number',
			settledUsedBytes: 0,
			quotaExceeded: false,
			usageUpdatedAt: 0,
			usageSettledThrough: 0,
			unlimitedTraffic: false,
			revision: 1,
		}),
	);

	const { payload } = await apiCall(kv, '/admin/api/customers');

	const v2 = payload.items.find((c) => c.customerId === v2Id);
	assert.ok(v2, 'v2 record must be listed after migration');
	assert.equal(v2.unlimitedTraffic, true);
	assert.equal(v2.quotaBytes, null);
	assert.equal(v2.remainingBytes, null);
	assert.equal(await totalCell(v2), '不限流量');

	const noUsage = payload.items.find((c) => c.customerId === noUsageId);
	assert.ok(noUsage, 'v4 base without usage must be listed as synthetic unlimited');
	assert.equal(noUsage.unlimitedTraffic, true);
	assert.equal(await totalCell(noUsage), '不限流量');

	const invalid = payload.items.find((c) => c.customerId === invalidId);
	assert.equal(invalid, undefined, 'invalid usage record must be skipped, not crash the list');
});
