import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto as realWebcrypto } from 'node:crypto';

// ---------------------------------------------------------------------------
// 全局桩：必须在 import _worker.js 之前安装。
//  - crypto.subtle：Node 的 WebCrypto 不支持 MD5，而 _worker.js 的 fetch 入口
//    每次请求都会调用 MD5MD5()，因此用 node:crypto 的 MD5 补齐。
//  - WebSocket / WebSocketPair：_worker.js 内部使用，测试用可控 mock 驱动
//    message/close/error 事件。
//  - Response：Node 的 Response 不允许 status 101（仅 200-599），而 WS 分支
//    需要构造 101 响应并携带 webSocket。
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

	json() {
		return Promise.resolve(JSON.parse(String(this.body ?? '')));
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

// VLESS 首包：version(1) + uuid(16) + optLen(1) + cmd(1) + port(2) + addrType(1) + 域名长度(1) + 域名 + payload。
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

function makeRequest({ upgrade = 'websocket', protocol = null, ua = 'Karing/1.0.0' } = {}) {
	const headers = { 'user-agent': ua, 'content-type': '' };
	if (upgrade) headers.upgrade = upgrade;
	if (protocol !== null) headers['sec-websocket-protocol'] = protocol;
	return {
		url: 'https://v20251104-membership-test.koookkong90.workers.dev/',
		method: 'GET',
		headers: makeHeaders(headers),
		cf: { colo: 'HKG', asn: 13335 },
		fetcher: null,
	};
}

function makeKv({ hangKeys = new Set() } = {}) {
	const store = new Map([
		[UUID_KEY, JSON.stringify({ schemaVersion: 2, customerId: CUSTOMER_ID, kind: 'membership-pointer' })],
		[
			`membership:customer:${CUSTOMER_ID}`,
			JSON.stringify({
				schemaVersion: 4,
				kind: 'membership-customer',
				customerId: CUSTOMER_ID,
				name: 'Test User',
				remark: '',
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
			}),
		],
		[
			`membership:usage:${CUSTOMER_ID}`,
			JSON.stringify({
				schemaVersion: 4,
				kind: 'membership-usage',
				customerId: CUSTOMER_ID,
				quotaBytes: 100 * 1024 ** 3,
				settledUsedBytes: 0,
				quotaExceeded: false,
				usageUpdatedAt: 0,
				usageSettledThrough: 0,
				unlimitedTraffic: false,
				revision: 1,
			}),
		],
	]);
	const kv = {
		gets: [],
		async get(key) {
			kv.gets.push(key);
			if (hangKeys.has(key)) {
				kv.pendingGet = new Promise(() => {});
				return kv.pendingGet;
			}
			return store.has(key) ? store.get(key) : null;
		},
		async put(key, value) {
			store.set(key, value);
		},
	};
	return kv;
}

function makeWriter({ hangFromCall = Infinity } = {}) {
	return {
		writeCalls: 0,
		releaseLockCalls: 0,
		write() {
			this.writeCalls++;
			return this.writeCalls >= hangFromCall ? new Promise(() => {}) : Promise.resolve();
		},
		releaseLock() {
			this.releaseLockCalls++;
		},
	};
}

function makeRemoteSocket({ hangFromCall = Infinity } = {}) {
	const writer = makeWriter({ hangFromCall });
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
	const fetcher = {
		connectCalls: [],
		connect(options) {
			fetcher.connectCalls.push(options);
			if (connectBehavior === 'hang') {
				fetcher.pendingConnect = new Promise(() => {});
				return fetcher.pendingConnect;
			}
			return socket;
		},
	};
	return fetcher;
}

function makeEngine({ writeBehavior = 'resolve' } = {}) {
	const engine = {
		points: [],
		writeDataPoint(point) {
			engine.points.push(point);
			if (writeBehavior === 'hang') return new Promise(() => {});
			if (writeBehavior === 'throw') throw new Error('simulated analytics write failure');
			return undefined;
		},
	};
	return engine;
}

function makeEnv({ kv = null, engine = null, fetcher = null, proxyIp = '192.0.2.1:443' } = {}) {
	return {
		ADMIN: 'test-admin-password',
		KEY: 'test-encryption-key',
		MEMBERSHIP_MODE: 'hybrid',
		PROXYIP: proxyIp,
		MEMBERSHIP_USAGE_SAMPLE_RATE: '1',
		DEBUG: 'false',
		KV: kv,
		MEMBERSHIP_USAGE: engine,
	};
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

// ---------------------------------------------------------------------------
// closeSocketQuietly 单元测试（从源码提取，注入 log 桩）
// ---------------------------------------------------------------------------

function extractCloseSocketQuietly() {
	const source = readFileSync(new URL('../_worker.js', import.meta.url), 'utf8');
	const match = source.match(/function closeSocketQuietly\(socket\) \{[\s\S]*?\n\}/);
	assert.ok(match, '应在 _worker.js 中找到 closeSocketQuietly 源码');
	const logs = [];
	const fn = new Function('log', `return (${match[0]});`)((...args) => logs.push(args));
	return { fn, logs };
}

test('closeSocketQuietly: socket 不存在时直接返回', () => {
	const { fn, logs } = extractCloseSocketQuietly();
	assert.doesNotThrow(() => fn(null));
	assert.doesNotThrow(() => fn(undefined));
	assert.equal(logs.length, 0);
});

test('closeSocketQuietly: 即使 readyState 为 CLOSED 也会调用 close()', () => {
	const { fn, logs } = extractCloseSocketQuietly();
	let closeCalls = 0;
	fn({ readyState: 3, close() { closeCalls++; } });
	assert.equal(closeCalls, 1, 'CLOSED 状态不得跳过 close()');
	assert.equal(logs.length, 0);
});

test('closeSocketQuietly: close() 抛错被吞掉并记录 DEBUG 日志', () => {
	const { fn, logs } = extractCloseSocketQuietly();
	assert.doesNotThrow(() => fn({ close() { throw new Error('boom'); } }));
	assert.equal(logs.length, 1);
	assert.match(String(logs[0][0]), /closeSocketQuietly/);
});

test('closeSocketQuietly: 普通 socket 正常关闭且不产生日志', () => {
	const { fn, logs } = extractCloseSocketQuietly();
	let closed = false;
	fn({ close() { closed = true; } });
	assert.equal(closed, true);
	assert.equal(logs.length, 0);
});

// ---------------------------------------------------------------------------
// WS 集成测试：101 立即返回
// ---------------------------------------------------------------------------

test('101 Response 在首包处理（KV 挂起）前立即返回', async () => {
	const kv = makeKv({ hangKeys: new Set([UUID_KEY]) });
	const request = makeRequest({ protocol: base64url(vlessPacket()) });
	const { response } = await openWs({ request, env: makeEnv({ kv }) });
	assert.equal(response.status, 101);
	assert.ok(kv.gets.includes(UUID_KEY), 'early data 应触发 UUID 鉴权 KV 读取');
	const state = await Promise.race([kv.pendingGet, timeout(50).then(() => 'pending')]);
	assert.equal(state, 'pending', 'KV get 仍挂起时 101 已返回');
});

// ---------------------------------------------------------------------------
// WS 集成测试：关闭路径
// ---------------------------------------------------------------------------

test('WebSocket 建立后客户端立即正常关闭，服务端同步 close', async () => {
	const { serverSock, clientSock, response } = await openWs();
	assert.equal(response.webSocket, clientSock, '101 应携带 clientSock');
	assert.equal(serverSock.acceptCalls, 1);
	serverSock.fire('close', {});
	assert.equal(serverSock.closeCalls, 1, 'close 事件处理器必须立即关闭服务端 socket');
	assert.equal(serverSock.readyState, MockWebSocket.CLOSED);
});

test('客户端不发送 Close frame 直接异常断开，服务端仍同步 close', async () => {
	const { serverSock } = await openWs();
	serverSock.fire('close', { code: 1006, reason: 'abnormal closure' });
	assert.equal(serverSock.closeCalls, 1);
	assert.equal(serverSock.readyState, MockWebSocket.CLOSED);
});

test('error 事件也立即关闭服务端 socket', async () => {
	const { serverSock } = await openWs();
	serverSock.fire('error', { message: 'network error' });
	assert.equal(serverSock.closeCalls, 1, 'error 路径必须立即 close');
});

test('KV get 挂起时客户端断开，服务端仍立即 close', async () => {
	const kv = makeKv({ hangKeys: new Set([UUID_KEY]) });
	const { serverSock } = await openWs({ env: makeEnv({ kv }) });
	serverSock.fire('message', { data: vlessPacket() });
	await timeout(20); // 让鉴权 KV get 进入挂起
	serverSock.fire('close', {});
	assert.equal(serverSock.closeCalls, 1, 'KV 鉴权挂起不得延迟 close');
});

test('TCP 拨号未完成时客户端断开，服务端仍立即 close', async () => {
	const kv = makeKv();
	const fetcher = makeFetcher({ connectBehavior: 'hang' });
	const request = makeRequest();
	request.fetcher = fetcher;
	const { serverSock } = await openWs({ request, env: makeEnv({ kv, fetcher }) });
	serverSock.fire('message', { data: vlessPacket() });
	await timeout(20); // 让拨号进入挂起
	assert.ok(fetcher.connectCalls.length >= 1, '应已发起 TCP 拨号');
	serverSock.fire('close', {});
	assert.equal(serverSock.closeCalls, 1, '拨号未完成不得延迟 close');
});

test('usageTracker.close 返回永不完成的 Promise 不阻塞 socket close', async () => {
	const kv = makeKv();
	const engine = makeEngine({ writeBehavior: 'hang' });
	const socket = makeRemoteSocket();
	const fetcher = makeFetcher({ socket });
	const request = makeRequest();
	request.fetcher = fetcher;
	const { serverSock } = await openWs({ request, env: makeEnv({ kv, engine, fetcher }) });
	serverSock.fire('message', { data: vlessPacket() });
	await timeout(20); // 完成建连与首包写入
	serverSock.fire('close', {});
	assert.equal(serverSock.closeCalls, 1, 'close 必须先于 Analytics 收尾完成');
	await timeout(30);
	assert.ok(engine.points.length >= 1, 'usageTracker.close 应已触发计量写入');
});

test('上行队列永不清空时，收尾在 1 秒超时后继续清理', async () => {
	const kv = makeKv();
	const socket = makeRemoteSocket({ hangFromCall: 2 }); // 首包写入成功，队列写入永远挂起
	const fetcher = makeFetcher({ socket });
	const request = makeRequest();
	request.fetcher = fetcher;
	const { serverSock } = await openWs({ request, env: makeEnv({ kv, fetcher }) });
	serverSock.fire('message', { data: vlessPacket() });
	await timeout(20);
	assert.equal(socket.writer.writeCalls, 1, '首包写入应完成');
	serverSock.fire('message', { data: new Uint8Array([0x01, 0x02, 0x03]) }); // 触发队列写入，永久挂起
	await timeout(20);
	assert.equal(socket.writer.writeCalls, 2, '队列写入应已发起');
	const startedAt = Date.now();
	serverSock.fire('close', {});
	for (let i = 0; i < 40 && socket.writer.releaseLockCalls < 2; i++) await timeout(50);
	assert.ok(socket.writer.releaseLockCalls >= 2, '超时后收尾应释放远端写入器');
	assert.ok(Date.now() - startedAt >= 900, '收尾应等待约 1 秒超时');
});

test('重复触发 close 事件与 closeSocketQuietly 不抛错', async () => {
	const { serverSock } = await openWs();
	assert.doesNotThrow(() => serverSock.fire('close', {}));
	assert.doesNotThrow(() => serverSock.fire('close', {}));
	assert.equal(serverSock.closeCalls, 2);
	assert.equal(serverSock.readyState, MockWebSocket.CLOSED);
});

test('close() 抛错时 close 事件处理不中断', async () => {
	const { serverSock } = await openWs();
	serverSock.closeError = new Error('simulated close failure');
	assert.doesNotThrow(() => serverSock.fire('close', {}));
	assert.equal(serverSock.closeCalls, 1);
	serverSock.closeError = null;
	assert.doesNotThrow(() => serverSock.fire('close', {}));
	assert.equal(serverSock.closeCalls, 2);
});
