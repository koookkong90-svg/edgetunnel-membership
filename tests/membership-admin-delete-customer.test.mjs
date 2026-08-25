// 安全永久删除客户功能回归测试。
//
// 覆盖：
//   1. 正常客户不能删除（409）
//   2. 未停用的过期客户不能删除（409）
//   3. 停用客户 + 正确确认 + 正确 revision 可删除，且删除顺序为 UUID→Token→usage→主记录
//   4. 确认名称错误不能删除（400）
//   5. revision 冲突不能删除（409）
//   6. 未认证（401）或 CSRF 错误（403）不能删除
//   7. 删除后客户不再出现在列表
//   8. 删除不影响其他客户记录
//   9. 删除后原 Token 不能通过会员鉴权（/sub 404），UUID 索引已清除
//  10. 部分删除失败后可安全重试
//  11. 前端只有停用客户显示“永久删除”按钮
//  12. 流量显示修复（200/100/0 GiB）仍在
//
// 直接加载仓库内真实模块（_worker.js 的 fetch 处理器 + admin-members.js 页面脚本），
// 全程使用内存 KV mock，不触碰任何真实 Cloudflare 资源。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';

const GIB = 1024 ** 3;
const REPO_ROOT = new URL('..', import.meta.url);

// Node 的 WebCrypto 不支持 MD5，而 _worker.js 的 MD5MD5（双重 MD5）依赖它。
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
const UA = 'edgetunnel-delete-test';
const ORIGIN = 'https://magic-membership-prod.pages.dev';

function md5md5(text) {
	const first = crypto.createHash('md5').update(text).digest('hex');
	return crypto.createHash('md5').update(first.slice(7, 27)).digest('hex');
}
function sha256(text) {
	return crypto.createHash('sha256').update(String(text)).digest('hex');
}

const AUTH_COOKIE = md5md5(UA + KEY + ADMIN);

function makeKv(options = {}) {
	const store = new Map();
	const failAlways = new Set(options.failAlwaysDeleteKeys || []);
	const failOnce = new Set(options.failOnceDeleteKeys || []);
	const deleteOrder = [];
	return {
		_store: store,
		_deleteOrder: deleteOrder,
		_failAlways: failAlways,
		_failOnce: failOnce,
		async get(key) {
			return store.has(key) ? store.get(key) : null;
		},
		async put(key, value) {
			store.set(key, String(value));
		},
		async delete(key) {
			deleteOrder.push(key);
			if (failAlways.has(key)) throw new Error('simulated KV delete failure');
			if (failOnce.has(key)) {
				failOnce.delete(key);
				throw new Error('simulated KV delete failure');
			}
			store.delete(key);
		},
		async list(options = {}) {
			const prefix = options.prefix || '';
			const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
			return { keys: keys.map((name) => ({ name })), list_complete: true, cursor: null };
		},
	};
}

function makeEnv(kv, membershipMode = 'hybrid') {
	return { ADMIN, KEY, KV: kv, MEMBERSHIP_MODE: membershipMode, DEBUG: 'false' };
}

function wrapRequest(real) {
	return new Proxy(real, {
		get: (target, prop) => (prop === 'cf' ? { colo: 'test', asn: 0, country: 'US' } : target[prop]),
	});
}

function adminRequest(urlPath, { method = 'GET', body, headers = {}, auth = true, csrf = true } = {}) {
	const init = { method, headers: { 'User-Agent': UA, ...headers } };
	if (auth) init.headers['Cookie'] = `auth=${AUTH_COOKIE}`;
	if (body !== undefined) {
		init.headers['Content-Type'] = 'application/json';
		if (csrf) {
			init.headers['Origin'] = ORIGIN;
			init.headers['X-Admin-Request'] = '1';
		}
		init.body = typeof body === 'string' ? body : JSON.stringify(body);
	}
	return wrapRequest(new Request(ORIGIN + urlPath, init));
}

async function apiCall(kv, urlPath, options) {
	const env = makeEnv(kv);
	const response = await worker.fetch(adminRequest(urlPath, options), env, { waitUntil() {} });
	const payload = await response.json();
	return { status: response.status, payload };
}

async function createCustomer(kv, trafficPlan = { quotaGiB: 100 }) {
	const idempotencyKey = 'del-' + crypto.randomBytes(12).toString('hex');
	const { status, payload } = await apiCall(kv, '/admin/api/customers', {
		method: 'POST',
		body: { name: '删除测试客户', remark: '', durationDays: 30, ...trafficPlan, idempotencyKey },
	});
	assert.equal(status, 201, `create should return 201, got ${status}: ${JSON.stringify(payload)}`);
	return {
		customerId: payload.customer.customerId,
		revision: payload.customer.revision,
		usageRevision: payload.customer.usageRevision,
		uuid: payload.customer.uuid,
		rawToken: payload.rawToken,
		name: payload.customer.name,
	};
}

async function disableCustomer(kv, customerId, revision) {
	const { status, payload } = await apiCall(kv, `/admin/api/customers/${customerId}/toggle`, {
		method: 'POST',
		body: { enabled: false, expectedRevision: revision },
	});
	assert.equal(status, 200, `toggle disable failed: ${JSON.stringify(payload)}`);
	return payload.customer;
}

async function deleteCustomerApi(kv, customerId, { revision, confirmName, auth = true, csrf = true }) {
	const env = makeEnv(kv);
	const response = await worker.fetch(
		adminRequest(`/admin/api/customers/${customerId}`, {
			method: 'DELETE',
			body: { expectedRevision: revision, confirmName },
			auth,
			csrf,
		}),
		env,
		{ waitUntil() {} },
	);
	const payload = await response.json();
	return { status: response.status, payload };
}

async function publicSubRequest(kv, rawToken) {
	const env = makeEnv(kv, 'membership');
	const response = await worker.fetch(
		wrapRequest(new Request(ORIGIN + '/sub?token=' + encodeURIComponent(rawToken), { method: 'GET', headers: { 'User-Agent': UA } })),
		env,
		{ waitUntil() {} },
	);
	return { status: response.status };
}

function seedCustomer(kv, { customerId, enabled = true, disableReason = null, expiresAt = null, uuidTail = '9' }) {
	const uuid = `00000000-0000-4000-8000-${String(uuidTail).padStart(12, '0')}`;
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
			tokenHash: sha256(customerId),
			tokenPreview: '••••abcd',
			state: 'active',
			enabled,
			expiresAt: expiresAt ?? now + 30 * 86400000,
			createdAt: now - 1000,
			updatedAt: now,
			revision: 1,
			disableReason,
		}),
	);
	kv._store.set(
		'membership:usage:' + customerId,
		JSON.stringify({
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
		}),
	);
	return { customerId, uuid, revision: 1, name: '种子客户' };
}

// ---------------- 前端脚本提取（渲染后页面，捕获模板转义问题） ----------------

let frontendPromise = null;
function getFrontend() {
	if (!frontendPromise) {
		frontendPromise = (async () => {
			const html = await (await adminModule.renderAdminMembersPage()).text();
			const scriptMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
			assert.ok(scriptMatch, 'inline admin script not found');
			const scriptSource = scriptMatch[1];
			const fmtMatch = scriptSource.match(/function formatTrafficBytes\(value\) \{[\s\S]*?\n\t\t\}/);
			assert.ok(fmtMatch, 'formatTrafficBytes not found');
			const dayMatch = scriptSource.match(/const DAY_MS[^;]*;/);
			assert.ok(dayMatch, 'constants not found');
			const sandbox = vm.createContext({ Date, Number, Object, Array, RegExp, Math, String, Boolean, console });
			vm.runInContext(dayMatch[0] + '\n' + fmtMatch[0] + '\nglobalThis.__fmt = formatTrafficBytes;', sandbox);
			return {
				scriptSource,
				formatTrafficBytes: (value) => vm.runInContext('__fmt(' + JSON.stringify(value) + ')', sandbox),
			};
		})();
	}
	return frontendPromise;
}

// ---------------- 测试 ----------------

test('正常客户不能删除（409）', async () => {
	const kv = makeKv();
	const created = await createCustomer(kv, { quotaGiB: 100 });
	const res = await deleteCustomerApi(kv, created.customerId, { revision: created.revision, confirmName: created.name });
	assert.equal(res.status, 409);
	assert.equal(res.payload.error.code, 'customer_not_disabled');
	assert.ok(kv._store.has('membership:customer:' + created.customerId));
	assert.ok(kv._store.has('membership:usage:' + created.customerId));
});

test('未停用的过期客户不能删除（409）', async () => {
	const kv = makeKv();
	const seeded = seedCustomer(kv, { customerId: 'cus_ExpiredNotDisabledAAAAAA', enabled: true, disableReason: null, expiresAt: Date.now() - 1000 });
	const res = await deleteCustomerApi(kv, seeded.customerId, { revision: seeded.revision, confirmName: seeded.name });
	assert.equal(res.status, 409);
	assert.equal(res.payload.error.code, 'customer_not_disabled');
	assert.ok(kv._store.has('membership:customer:' + seeded.customerId));
});

test('停用客户＋正确确认＋正确revision可删除，删除顺序为UUID→Token→usage→主记录', async () => {
	const kv = makeKv();
	const created = await createCustomer(kv, { quotaGiB: 100 });
	const disabled = await disableCustomer(kv, created.customerId, created.revision);
	assert.equal(disabled.enabled, false);
	assert.equal(disabled.disableReason, 'manual');
	const res = await deleteCustomerApi(kv, created.customerId, { revision: disabled.revision, confirmName: created.name });
	assert.equal(res.status, 200);
	assert.deepEqual(res.payload, { deleted: true });
	const expectedOrder = [
		'membership:uuid:' + created.uuid,
		'membership:token:' + sha256(created.rawToken),
		'membership:usage:' + created.customerId,
		'membership:customer:' + created.customerId,
	];
	assert.deepEqual(kv._deleteOrder, expectedOrder);
	for (const key of expectedOrder) {
		assert.equal(kv._store.has(key), false, `key should be deleted: ${key}`);
	}
});

test('确认名称错误不能删除（400）且记录保留', async () => {
	const kv = makeKv();
	const created = await createCustomer(kv, { quotaGiB: 100 });
	const disabled = await disableCustomer(kv, created.customerId, created.revision);
	const res = await deleteCustomerApi(kv, created.customerId, { revision: disabled.revision, confirmName: '错误名称' });
	assert.equal(res.status, 400);
	assert.equal(res.payload.error.code, 'invalid_confirmation');
	assert.ok(kv._store.has('membership:customer:' + created.customerId));
	assert.ok(kv._store.has('membership:usage:' + created.customerId));
	assert.ok(kv._store.has('membership:uuid:' + created.uuid));
});

test('revision冲突不能删除（409）且记录保留', async () => {
	const kv = makeKv();
	const created = await createCustomer(kv, { quotaGiB: 100 });
	const disabled = await disableCustomer(kv, created.customerId, created.revision);
	const res = await deleteCustomerApi(kv, created.customerId, { revision: 999, confirmName: created.name });
	assert.equal(res.status, 409);
	assert.equal(res.payload.error.code, 'revision_conflict');
	assert.ok(kv._store.has('membership:customer:' + created.customerId));
	assert.ok(kv._store.has('membership:usage:' + created.customerId));
});

test('未认证（401）或CSRF错误（403）不能删除', async () => {
	const kv = makeKv();
	const created = await createCustomer(kv, { quotaGiB: 100 });
	const disabled = await disableCustomer(kv, created.customerId, created.revision);
	const unauth = await deleteCustomerApi(kv, created.customerId, { revision: disabled.revision, confirmName: created.name, auth: false });
	assert.equal(unauth.status, 401);
	const csrfBad = await deleteCustomerApi(kv, created.customerId, { revision: disabled.revision, confirmName: created.name, csrf: false });
	assert.equal(csrfBad.status, 403);
	assert.ok(kv._store.has('membership:customer:' + created.customerId));
	assert.ok(kv._store.has('membership:usage:' + created.customerId));
});

test('删除后客户不再出现在列表', async () => {
	const kv = makeKv();
	const created = await createCustomer(kv, { quotaGiB: 100 });
	const disabled = await disableCustomer(kv, created.customerId, created.revision);
	const res = await deleteCustomerApi(kv, created.customerId, { revision: disabled.revision, confirmName: created.name });
	assert.equal(res.status, 200);
	const { payload } = await apiCall(kv, '/admin/api/customers');
	assert.equal(payload.items.some((c) => c.customerId === created.customerId), false);
});

test('删除不影响其他客户记录', async () => {
	const kv = makeKv();
	const a = await createCustomer(kv, { quotaGiB: 200 });
	const b = await createCustomer(kv, { quotaGiB: 100 });
	const before = {
		customer: kv._store.get('membership:customer:' + b.customerId),
		usage: kv._store.get('membership:usage:' + b.customerId),
		uuid: kv._store.get('membership:uuid:' + b.uuid),
		token: kv._store.get('membership:token:' + sha256(b.rawToken)),
	};
	const disabledA = await disableCustomer(kv, a.customerId, a.revision);
	const res = await deleteCustomerApi(kv, a.customerId, { revision: disabledA.revision, confirmName: a.name });
	assert.equal(res.status, 200);
	assert.equal(kv._store.get('membership:customer:' + b.customerId), before.customer);
	assert.equal(kv._store.get('membership:usage:' + b.customerId), before.usage);
	assert.equal(kv._store.get('membership:uuid:' + b.uuid), before.uuid);
	assert.equal(kv._store.get('membership:token:' + sha256(b.rawToken)), before.token);
});

test('删除后原Token不能通过会员鉴权（/sub 404），UUID索引已清除', async () => {
	const kv = makeKv();
	const created = await createCustomer(kv, { quotaGiB: 100 });
	const before = await publicSubRequest(kv, created.rawToken);
	assert.notEqual(before.status, 404, 'token should resolve before deletion');
	const disabled = await disableCustomer(kv, created.customerId, created.revision);
	const res = await deleteCustomerApi(kv, created.customerId, { revision: disabled.revision, confirmName: created.name });
	assert.equal(res.status, 200);
	const after = await publicSubRequest(kv, created.rawToken);
	assert.equal(after.status, 404);
	assert.equal(kv._store.has('membership:uuid:' + created.uuid), false);
});

test('部分删除失败后可安全重试', async () => {
	const kv = makeKv();
	const created = await createCustomer(kv, { quotaGiB: 100 });
	const disabled = await disableCustomer(kv, created.customerId, created.revision);
	const usageKey = 'membership:usage:' + created.customerId;
	kv._failOnce.add(usageKey);
	const first = await deleteCustomerApi(kv, created.customerId, { revision: disabled.revision, confirmName: created.name });
	assert.equal(first.status, 503);
	assert.ok(kv._store.has('membership:customer:' + created.customerId), 'main record must survive for retry');
	assert.ok(kv._store.has(usageKey), 'failed usage record must survive');
	const second = await deleteCustomerApi(kv, created.customerId, { revision: disabled.revision, confirmName: created.name });
	assert.equal(second.status, 200);
	assert.equal(kv._store.has('membership:customer:' + created.customerId), false);
	assert.equal(kv._store.has(usageKey), false);
	assert.equal(kv._store.has('membership:uuid:' + created.uuid), false);
	assert.equal(kv._store.has('membership:token:' + sha256(created.rawToken)), false);
});

test('前端只有停用客户显示永久删除按钮', async () => {
	const { scriptSource } = await getFrontend();
	const start = scriptSource.indexOf('function createActionsCell(customer)');
	assert.ok(start >= 0, 'createActionsCell not found');
	const fn = scriptSource.slice(start, start + 1800);
	assert.ok(fn.includes('永久删除'), 'delete button must exist');
	const guardIdx = fn.indexOf("customer.enabled === false && customer.disableReason === 'manual'");
	const deleteIdx = fn.indexOf('永久删除');
	const toggleIdx = fn.indexOf('targetEnabled ?');
	const copyIdx = fn.indexOf('复制UUID');
	assert.ok(guardIdx >= 0 && guardIdx < deleteIdx, '永久删除 must be inside the disabled-only guard');
	assert.ok(toggleIdx >= 0 && toggleIdx < deleteIdx, 'toggle button must come before delete button');
	assert.ok(copyIdx > deleteIdx, 'delete button must come before copy-UUID button');
});

test('流量显示修复仍在（渲染脚本 formatTrafficBytes 输出完整数字）', async () => {
	const { formatTrafficBytes } = await getFrontend();
	assert.equal(formatTrafficBytes(200 * GIB), '200 GiB');
	assert.equal(formatTrafficBytes(100 * GIB), '100 GiB');
	assert.equal(formatTrafficBytes(0), '0 GiB');
});
