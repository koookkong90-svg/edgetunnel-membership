import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto as realWebcrypto } from 'node:crypto';

// ---------------------------------------------------------------------------
// 全局桩：必须在 import _worker.js 之前安装（与 membership-ws-close 测试同构）。
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

let lastPair = null;

class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	constructor() {
		this.readyState = MockWebSocket.OPEN;
		this.binaryType = 'blob';
		this.listeners = { message: [], close: [], error: [] };
		this.acceptCalls = 0;
		this.closeCalls = 0;
		this.sendCalls = [];
		this.closeError = null;
	}

	accept() {
		this.acceptCalls++;
	}

	addEventListener(type, handler) {
		if (!this.listeners[type]) this.listeners[type] = [];
		this.listeners[type].push(handler);
	}

	send(data) {
		this.sendCalls.push(data);
	}

	close() {
		this.closeCalls++;
		if (this.closeError) throw this.closeError;
		this.readyState = MockWebSocket.CLOSED;
	}

	fire(type, event) {
		for (const handler of [...(this.listeners[type] || [])]) handler(event);
	}
}

class MockWebSocketPair {
	constructor() {
		this[0] = new MockWebSocket();
		this[1] = new MockWebSocket();
		lastPair = this;
	}
}

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
}

Object.defineProperty(globalThis, 'WebSocket', { value: MockWebSocket, configurable: true, writable: true });
Object.defineProperty(globalThis, 'WebSocketPair', { value: MockWebSocketPair, configurable: true, writable: true });
Object.defineProperty(globalThis, 'Response', { value: MockResponse, configurable: true, writable: true });

const worker = (await import('../_worker.js')).default;

// ---------------------------------------------------------------------------
// 测试数据与工具
// ---------------------------------------------------------------------------

const CUSTOMER_ID = 'cus_test1234567890abcd';
const CUSTOMER_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const UUID_KEY = `membership:uuid:${CUSTOMER_UUID}`;
const POLICY_VERSION = 'usage-v1';

function hexToBytes(hex) {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return bytes;
}

function uuidBytes(uuid) {
	return hexToBytes(uuid.replace(/-/g, ''));
}

function base64url(bytes) {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function vlessPacket({ uuid = CUSTOMER_UUID, cmd = 1, port = 443, host = 'example.com', payload = new Uint8Array([0]) } = {}) {
	const hostBytes = new TextEncoder().encode(host);
	const parts = [
		0,
		...uuidBytes(uuid),
		0,
		cmd,
		(port >> 8) & 0xff,
		port & 0xff,
		2,
		hostBytes.length,
		...hostBytes,
		...payload,
	];
	return Uint8Array.from(parts);
}

function makeHeaders(entries = {}) {
	const map = new Map(Object.entries(entries).map(([key, value]) => [String(key).toLowerCase(), String(value)]));
	return {
		get(name) {
			const key = String(name).toLowerCase();
			return map.has(key) ? map.get(key) : null;
		},
	};
}

function makeRequest({ path = '/', upgrade = 'websocket', protocol = null, ua = 'Karing/1.0.0' } = {}) {
	const headers = { 'user-agent': ua, 'content-type': '' };
	if (upgrade) headers.upgrade = upgrade;
	if (protocol !== null) headers['sec-websocket-protocol'] = protocol;
	return {
		url: `https://v20251104-membership-test.koookkong90.workers.dev${path}`,
		method: 'GET',
		headers: makeHeaders(headers),
		cf: { colo: 'HKG', asn: 13335 },
		fetcher: null,
	};
}

function makeKv({
	omitRecords = false,
	expiresAt = 1_999_999_999_999,
	enabled = true,
	disableReason = null,
	settledUsedBytes = 0,
	quotaBytes = 100 * 1024 ** 3,
	unlimitedTraffic = false,
} = {}) {
	const store = new Map();
	if (!omitRecords) {
		store.set(UUID_KEY, JSON.stringify({ schemaVersion: 2, customerId: CUSTOMER_ID, kind: 'membership-pointer' }));
		store.set(`membership:customer:${CUSTOMER_ID}`, JSON.stringify({
			schemaVersion: 4,
			kind: 'membership-customer',
			customerId: CUSTOMER_ID,
			name: 'Test User',
			remark: '',
			uuid: CUSTOMER_UUID,
			tokenHash: '0'.repeat(64),
			tokenPreview: '••••abcd',
			state: 'active',
			enabled,
			expiresAt,
			createdAt: 1_700_000_000_000,
			updatedAt: 1_700_000_000_000,
			revision: 1,
			disableReason,
		}));
		store.set(`membership:usage:${CUSTOMER_ID}`, JSON.stringify({
			schemaVersion: 4,
			kind: 'membership-usage',
			customerId: CUSTOMER_ID,
			quotaBytes,
			settledUsedBytes,
			quotaExceeded: unlimitedTraffic === false && settledUsedBytes >= quotaBytes,
			usageUpdatedAt: 0,
			usageSettledThrough: 0,
			unlimitedTraffic,
			revision: 1,
		}));
	}
	return {
		gets: [],
		async get(key) {
			this.gets.push(key);
			return store.has(key) ? store.get(key) : null;
		},
		async put(key, value) {
			store.set(key, value);
		},
	};
}

function makeEngine({ writeBehavior = 'resolve' } = {}) {
	return {
		points: [],
		writeDataPoint(point) {
			this.points.push(point);
			if (writeBehavior === 'hang') return new Promise(() => {});
			if (writeBehavior === 'throw') throw new Error('simulated analytics write failure');
			return undefined;
		},
	};
}

function makeRemoteSocket() {
	const writer = {
		writeCalls: 0,
		releaseLockCalls: 0,
		write() {
			this.writeCalls++;
			return Promise.resolve();
		},
		releaseLock() {
			this.releaseLockCalls++;
		},
	};
	const socket = {
		writer,
		closedFlag: false,
		opened: Promise.resolve(),
		closed: Promise.resolve(),
		close() {
			socket.closedFlag = true;
		},
		readable: {
			getReader() {
				return {
					read: () => new Promise(() => {}),
					cancel: async () => {},
					releaseLock() {},
				};
			},
		},
		writable: {
			getWriter() {
				return writer;
			},
		},
	};
	return socket;
}

function makeFetcher({ socket = null, connectBehavior = 'resolve' } = {}) {
	return {
		connectCalls: [],
		connect(options) {
			this.connectCalls.push(options);
			if (connectBehavior === 'hang') return new Promise(() => {});
			return socket;
		},
	};
}

function makeEnv({ kv = null, engine = null, fetcher = null, proxyIp = '192.0.2.1:443', blockGib } = {}) {
	const env = {
		ADMIN: 'test-admin-password',
		KEY: 'test-encryption-key',
		MEMBERSHIP_MODE: 'hybrid',
		PROXYIP: proxyIp,
		MEMBERSHIP_USAGE_SAMPLE_RATE: '1',
		DEBUG: 'false',
		KV: kv,
		MEMBERSHIP_USAGE: engine,
	};
	if (blockGib !== undefined) env.MEMBERSHIP_USAGE_BLOCK_GIB = blockGib;
	return env;
}

async function openWs({ request = makeRequest(), env = makeEnv() } = {}) {
	lastPair = null;
	const response = await worker.fetch(request, env, { waitUntil() {} });
	assert.equal(response.status, 101, 'WS 请求必须返回 101');
	assert.ok(lastPair, '必须创建 WebSocketPair');
	const pair = lastPair;
	lastPair = null;
	return { response, clientSock: pair[0], serverSock: pair[1] };
}

function timeout(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function pointsByKind(engine, kind) {
	return engine.points.filter(point => point.blobs && point.blobs[2] === kind);
}

async function md5Hex(text) {
	const digest = await crypto.subtle.digest('MD5', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// 与 fetch 入口一致的 legacy userID 推导（MD5MD5 两次哈希后按版本 4 格式重组）。
async function adminUuid() {
	const first = await md5Hex('test-admin-password' + 'test-encryption-key');
	const second = await md5Hex(first.slice(7, 27));
	return `${second.slice(0, 8)}-${second.slice(8, 12)}-4${second.slice(13, 16)}-8${second.slice(17, 20)}-${second.slice(20)}`;
}

// ---------------------------------------------------------------------------
// connect 事件测试
// ---------------------------------------------------------------------------

test('正常客户 VLESS 连接恰好产生一次 connect 事件', async () => {
	const kv = makeKv();
	const engine = makeEngine();
	const socket = makeRemoteSocket();
	const fetcher = makeFetcher({ socket });
	const request = makeRequest();
	request.fetcher = fetcher;
	const { serverSock } = await openWs({ request, env: makeEnv({ kv, engine, fetcher }) });
	serverSock.fire('message', { data: vlessPacket() });
	await timeout(30);
	assert.equal(pointsByKind(engine, 'connect').length, 1);
});

test('同一连接多次发送数据仍只有一次 connect', async () => {
	const kv = makeKv();
	const engine = makeEngine();
	const socket = makeRemoteSocket();
	const fetcher = makeFetcher({ socket });
	const request = makeRequest();
	request.fetcher = fetcher;
	const { serverSock } = await openWs({ request, env: makeEnv({ kv, engine, fetcher }) });
	serverSock.fire('message', { data: vlessPacket() });
	await timeout(30);
	for (let i = 0; i < 5; i++) serverSock.fire('message', { data: new Uint8Array([0x01, 0x02, 0x03]) });
	await timeout(30);
	assert.equal(pointsByKind(engine, 'connect').length, 1);
});

test('拨号挂起时重复首包不产生第二次 connect（fallback/retry 语义）', async () => {
	const kv = makeKv();
	const engine = makeEngine();
	const fetcher = makeFetcher({ connectBehavior: 'hang' });
	const request = makeRequest();
	request.fetcher = fetcher;
	const { serverSock } = await openWs({ request, env: makeEnv({ kv, engine, fetcher }) });
	serverSock.fire('message', { data: vlessPacket() });
	await timeout(20);
	serverSock.fire('message', { data: vlessPacket() });
	await timeout(20);
	assert.equal(pointsByKind(engine, 'connect').length, 1);
	serverSock.fire('close', {});
});

test('Early Data 只产生一次 connect（拨号挂起时重发首包也不重复）', async () => {
	const kv = makeKv();
	const engine = makeEngine();
	const fetcher = makeFetcher({ connectBehavior: 'hang' });
	const request = makeRequest({ protocol: base64url(vlessPacket()) });
	request.fetcher = fetcher;
	const { serverSock } = await openWs({ request, env: makeEnv({ kv, engine, fetcher }) });
	await timeout(30);
	assert.equal(pointsByKind(engine, 'connect').length, 1, 'early data 应记 1 次');
	serverSock.fire('message', { data: vlessPacket() });
	await timeout(30);
	assert.equal(pointsByKind(engine, 'connect').length, 1, '重发首包不得再记');
	serverSock.fire('close', {});
});

test('DNS 客户连接只产生一次 connect', async () => {
	const kv = makeKv();
	const engine = makeEngine();
	const socket = makeRemoteSocket();
	const fetcher = makeFetcher({ socket });
	const request = makeRequest();
	request.fetcher = fetcher;
	const { serverSock } = await openWs({ request, env: makeEnv({ kv, engine, fetcher }) });
	serverSock.fire('message', {
		data: vlessPacket({ cmd: 2, port: 53, host: 'dns.google', payload: new Uint8Array([0x12, 0x34]) }),
	});
	await timeout(30);
	assert.equal(pointsByKind(engine, 'connect').length, 1);
});

for (const [name, options] of [
	['UUID 鉴权失败', { omitRecords: true }],
	['客户已到期', { expiresAt: Date.now() - 1000 }],
	['客户已超额', { settledUsedBytes: 100 * 1024 ** 3, quotaBytes: 100 * 1024 ** 3 }],
	['客户已手动停用', { enabled: false, disableReason: 'manual' }],
]) {
	test(`${name}不产生 connect 事件`, async () => {
		const kv = makeKv(options);
		const engine = makeEngine();
		const fetcher = makeFetcher({ connectBehavior: 'hang' });
		const request = makeRequest();
		request.fetcher = fetcher;
		const { serverSock } = await openWs({ request, env: makeEnv({ kv, engine, fetcher }) });
		serverSock.fire('message', { data: vlessPacket() });
		await timeout(30);
		assert.equal(engine.points.length, 0);
	});
}

test('legacy 连接不产生会员 connect', async () => {
	const kv = makeKv();
	const engine = makeEngine();
	const fetcher = makeFetcher({ connectBehavior: 'hang' });
	const request = makeRequest();
	request.fetcher = fetcher;
	const { serverSock } = await openWs({ request, env: makeEnv({ kv, engine, fetcher }) });
	serverSock.fire('message', { data: vlessPacket({ uuid: await adminUuid() }) });
	await timeout(30);
	assert.equal(engine.points.length, 0);
});

test('SS 连接不产生会员 connect', async () => {
	const kv = makeKv();
	const engine = makeEngine();
	const request = makeRequest({ path: '/?enc=aes-128-gcm' });
	const { serverSock } = await openWs({ request, env: makeEnv({ kv, engine }) });
	serverSock.fire('message', { data: vlessPacket() });
	await timeout(30);
	assert.equal(engine.points.length, 0);
});

test('Trojan 连接不产生会员 connect', async () => {
	const kv = makeKv();
	const engine = makeEngine();
	const request = makeRequest();
	const { serverSock } = await openWs({ request, env: makeEnv({ kv, engine }) });
	const trojan = new Uint8Array(64).fill(0x41);
	trojan[56] = 0x0d;
	trojan[57] = 0x0a;
	serverSock.fire('message', { data: trojan });
	await timeout(30);
	assert.equal(engine.points.length, 0);
});

test('gRPC/XHTTP POST 不产生会员 connect', async () => {
	const kv = makeKv();
	const engine = makeEngine();
	const request = {
		url: 'https://v20251104-membership-test.koookkong90.workers.dev/',
		method: 'POST',
		headers: makeHeaders({ 'user-agent': 'test', 'content-type': 'application/grpc' }),
		cf: { colo: 'HKG', asn: 13335 },
		body: undefined,
		fetcher: null,
	};
	lastPair = null;
	const response = await worker.fetch(request, makeEnv({ kv, engine }), { waitUntil() {} });
	assert.equal(response.status, 400);
	assert.equal(lastPair, null, '不得创建 WebSocket');
	assert.equal(engine.points.length, 0);
});

test('Analytics 绑定缺失时连接仍正常', async () => {
	const kv = makeKv();
	const socket = makeRemoteSocket();
	const fetcher = makeFetcher({ socket });
	const request = makeRequest();
	request.fetcher = fetcher;
	const { serverSock } = await openWs({ request, env: makeEnv({ kv, engine: undefined, fetcher }) });
	serverSock.fire('message', { data: vlessPacket() });
	await timeout(30);
	assert.ok(fetcher.connectCalls.length >= 1, '代理建连应继续');
	assert.equal(serverSock.readyState, MockWebSocket.OPEN, 'socket 不应被关闭');
});

test('writeDataPoint 抛错时连接仍正常', async () => {
	const kv = makeKv();
	const engine = makeEngine({ writeBehavior: 'throw' });
	const socket = makeRemoteSocket();
	const fetcher = makeFetcher({ socket });
	const request = makeRequest();
	request.fetcher = fetcher;
	const { serverSock } = await openWs({ request, env: makeEnv({ kv, engine, fetcher }) });
	serverSock.fire('message', { data: vlessPacket() });
	await timeout(30);
	assert.ok(fetcher.connectCalls.length >= 1, '代理建连应继续');
	assert.equal(serverSock.readyState, MockWebSocket.OPEN, 'socket 不应被关闭');
});

test('connect 事件结构正确且不含敏感字段', async () => {
	const kv = makeKv();
	const engine = makeEngine();
	const fetcher = makeFetcher({ connectBehavior: 'hang' });
	const request = makeRequest();
	request.fetcher = fetcher;
	const { serverSock } = await openWs({ request, env: makeEnv({ kv, engine, fetcher }) });
	serverSock.fire('message', { data: vlessPacket() });
	await timeout(30);
	const points = pointsByKind(engine, 'connect');
	assert.equal(points.length, 1);
	const point = points[0];
	assert.deepEqual(point.indexes, [CUSTOMER_ID]);
	assert.deepEqual(point.blobs, ['usage-v1', 'vless-ws', 'connect', POLICY_VERSION]);
	assert.deepEqual(point.doubles, [0, 0, 1, 1]);
	const serialized = JSON.stringify(point);
	assert.ok(!serialized.includes(CUSTOMER_UUID), '不得包含客户 UUID');
	assert.ok(!serialized.includes('Test User'), '不得包含客户名称');
	assert.ok(!serialized.includes('example.com'), '不得包含目标域名');
});

test('原有 block/interval/close 事件行为不变', async () => {
	const kv = makeKv();
	const engine = makeEngine();
	const socket = makeRemoteSocket();
	const fetcher = makeFetcher({ socket });
	const request = makeRequest();
	request.fetcher = fetcher;
	const { serverSock } = await openWs({
		request,
		env: makeEnv({ kv, engine, fetcher, blockGib: '0.0000002' }),
	});
	serverSock.fire('message', { data: vlessPacket() });
	await timeout(30);
	serverSock.fire('message', { data: new Uint8Array(300).fill(0x55) });
	await timeout(30);
	assert.ok(pointsByKind(engine, 'block').length >= 1, '应产生 block 事件');
	assert.equal(pointsByKind(engine, 'connect').length, 1);
	serverSock.fire('close', {});
	await timeout(30);
	assert.ok(pointsByKind(engine, 'close').length >= 1, '应产生 close 事件');
});
