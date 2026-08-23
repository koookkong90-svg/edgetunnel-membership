function generatePageNonce() {
	const bytes = new Uint8Array(18);
	crypto.getRandomValues(bytes);
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function renderAdminMembersPage() {
	const nonce = generatePageNonce();
	const html = `<!doctype html>
<html lang=zh-CN>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>会员管理</title>
	<style nonce="${nonce}">
		:root { color-scheme: light; font-family: system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:#f4f7fb; color:#172033 }
		* { box-sizing:border-box } body { margin:0; min-width:280px; background:#f4f7fb } button,input,select { font:inherit }
		button,.button-link { min-height:44px; border:1px solid transparent; border-radius:10px; padding:.65rem 1rem; background:#1457d9; color:#fff; cursor:pointer; font-weight:650; text-decoration:none; display:inline-flex; align-items:center; justify-content:center }
		button:hover,.button-link:hover { background:#0e47b7 } button:disabled { cursor:not-allowed; opacity:.58 }
		button:focus-visible,.button-link:focus-visible,input:focus-visible,select:focus-visible { outline:3px solid rgba(20,87,217,.25); outline-offset:2px }
		.button-link.secondary,button.secondary { background:#fff; border-color:#ccd5e4; color:#26344d }
		.button-link.secondary:hover,button.secondary:hover { background:#edf2f8 }
		.page { width:min(1500px,100%); margin:0 auto; padding:1.25rem }
		.topbar { display:flex; align-items:center; justify-content:space-between; gap:1rem; margin-bottom:1rem }
		.topbar h1 { margin:0; font-size:clamp(1.5rem,3vw,2.15rem) } .topbar-actions { display:flex; flex-wrap:wrap; gap:.65rem }
		.panel { background:#fff; border:1px solid #dce3ee; border-radius:15px; box-shadow:0 8px 24px rgba(27,45,78,.06); padding:1rem; margin-bottom:1rem }
		.notice { margin:0 0 .9rem; color:#536176 } .message { border-radius:10px; padding:.8rem 1rem; margin-bottom:1rem }
		.message.error { color:#8e1c25; background:#fff0f1; border:1px solid #f4c5ca } .message.info { color:#17488a; background:#edf5ff; border:1px solid #c9defb }
		.stats { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:.75rem }
		.stat { border:1px solid #e1e7f0; border-radius:12px; padding:.85rem; background:#fbfcfe }
		.stat-label { color:#617087; font-size:.82rem } .stat-value { margin-top:.25rem; font-size:1.45rem; font-weight:750 }
		.toolbar { display:grid; grid-template-columns:minmax(220px,1fr) minmax(150px,230px); gap:.8rem; align-items:end }
		.field { display:grid; gap:.35rem } .field label { color:#43516a; font-size:.9rem; font-weight:650 }
		.field input,.field select,.field textarea { width:100%; min-height:44px; border:1px solid #cbd5e3; border-radius:10px; background:#fff; color:#172033; padding:.65rem .75rem }
		.field textarea { min-height:88px; resize:vertical } .create-grid { display:grid; grid-template-columns:minmax(180px,1fr) minmax(220px,1.4fr) minmax(120px,.5fr) minmax(140px,.55fr); gap:.8rem; align-items:start }
		.checkbox-field { display:flex; align-items:center; gap:.55rem; min-height:44px } .checkbox-field input { width:20px; min-height:20px }
		.quick-days,.form-actions,.secret-actions,.customer-actions { display:flex; flex-wrap:wrap; gap:.55rem; align-items:center }
		.quick-days { margin-top:.8rem } .form-actions { margin-top:1rem } button.small { min-height:44px; padding:.55rem .7rem; font-size:.82rem }
		button.danger { background:#a3212b } button.danger:hover { background:#821821 }
		.secret-panel { border-color:#e1bd55; background:#fffaf0 } .secret-warning { color:#7a5000; font-weight:750 }
		.secret-grid { display:grid; grid-template-columns:minmax(130px,.35fr) minmax(0,1fr); gap:.55rem .9rem; margin:1rem 0 }
		.secret-label { color:#59677c; font-weight:700 } .secret-value { overflow-wrap:anywhere; word-break:break-word; white-space:pre-wrap; font-family:ui-monospace,SFMono-Regular,Consolas,monospace }
		.clipboard-fallback { position:fixed; left:-9999px; opacity:0 }
		.edit-panel { border-color:#a9c4ee } .edit-heading { display:flex; justify-content:space-between; gap:1rem; align-items:flex-start }
		.edit-heading h2 { margin-top:0 } .edit-customer-id { overflow-wrap:anywhere; color:#59677c }
		.migration { margin-top:.85rem; color:#704d00; background:#fff8df; border:1px solid #eed68c; border-radius:10px; padding:.75rem }
		.table-wrap { overflow-x:auto } table { width:100%; border-collapse:collapse; min-width:1550px }
		th,td { padding:.75rem .6rem; border-bottom:1px solid #e5eaf1; text-align:left; vertical-align:top } th { color:#536176; background:#f8fafc; font-size:.82rem; white-space:nowrap } td { font-size:.9rem }
		.wrap-value { overflow-wrap:anywhere; word-break:break-word } .muted { color:#6a778b }
		.status { display:inline-flex; border-radius:999px; padding:.26rem .56rem; font-size:.78rem; font-weight:700; white-space:nowrap }
		.status.normal { color:#17613b; background:#e8f7ef } .status.disabled { color:#7b3c00; background:#fff1df } .status.expired,.status.quota { color:#8e1c25; background:#ffecef } .status.pending { color:#55429a; background:#f1edff }
		.status-note { display:block; margin-top:.3rem; font-size:.75rem; color:#8e1c25 } .empty { text-align:center; padding:2rem 1rem; color:#647187 }
		.list-footer { display:flex; justify-content:center; padding-top:1rem } .loading { opacity:.65 }
		@media (max-width:980px) { .stats { grid-template-columns:repeat(3,minmax(0,1fr)) } }
		@media (max-width:760px) {
			.page { padding:.8rem } .topbar { align-items:flex-start; flex-direction:column } .topbar-actions { width:100% } .topbar-actions>* { flex:1 1 130px }
			.create-grid,.secret-grid { grid-template-columns:1fr } .secret-label { margin-top:.35rem } .customer-actions { align-items:stretch } .customer-actions button { flex:1 1 115px }
			.stats { grid-template-columns:repeat(2,minmax(0,1fr)) } .toolbar { grid-template-columns:1fr } .table-wrap { overflow:visible }
			table,tbody,tr,td { display:block; min-width:0; width:100% } thead { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap }
			tbody { display:grid; gap:.8rem } tr { border:1px solid #dce3ee; border-radius:12px; padding:.45rem .75rem; background:#fff }
			td { display:grid; grid-template-columns:minmax(6.5rem,34%) minmax(0,1fr); gap:.7rem; border-bottom:1px dashed #e2e7ef; padding:.65rem 0 }
			td:last-child { border-bottom:0 } td::before { content:attr(data-label); color:#637087; font-size:.8rem; font-weight:700 } .empty { display:block } .empty::before { content:none }
		}
		@media (max-width:420px) { .stat { padding:.7rem } td { grid-template-columns:1fr; gap:.25rem } }
	</style>
</head>
<body>
	<main class="page">
		<header class="topbar">
			<h1>会员管理</h1>
			<div class="topbar-actions">
				<a id="admin-link" class="button-link secondary" href="/admin">返回原后台</a>
				<button id="refresh-button" type="button">刷新列表</button>
			</div>
		</header>
		<div id="message" class="message" role="status" aria-live="polite" hidden></div>
		<section class="panel" aria-labelledby="create-title">
			<h2 id="create-title">创建客户</h2>
			<form id="create-form" novalidate>
				<div class="create-grid">
					<div class="field"><label for="create-name">客户名称</label><input id="create-name" type="text" maxlength="80" autocomplete="off" required></div>
					<div class="field"><label for="create-remark">备注</label><textarea id="create-remark" maxlength="500" autocomplete="off"></textarea></div>
					<div class="field"><label for="create-duration">套餐天数</label><input id="create-duration" type="number" min="1" max="3650" step="1" inputmode="numeric" value="30" required></div>
					<div class="field"><label for="create-quota">总流量额度（GiB）</label><input id="create-quota" type="number" min="1" max="1000000" step="1" inputmode="numeric" value="100" required><label class="checkbox-field" for="create-unlimited"><input id="create-unlimited" type="checkbox">不限流量</label></div>
				</div>
				<div class="quick-days" aria-label="快捷套餐">
					<button class="secondary quick-day" type="button" data-days="30" data-quota="100">30天 / 100 GiB</button><button class="secondary quick-day" type="button" data-days="90" data-quota="300">90天 / 300 GiB</button><button class="secondary quick-day" type="button" data-days="180" data-quota="800">180天 / 800 GiB</button><button class="secondary quick-day" type="button" data-days="365" data-quota="2048">365天 / 2048 GiB</button>
				</div>
				<div class="form-actions"><button id="create-button" type="submit">创建客户</button></div>
			</form>
		</section>
		<section id="secret-panel" class="panel secret-panel" aria-labelledby="secret-title" hidden>
			<h2 id="secret-title">一次性订阅凭据</h2>
			<p class="secret-warning">订阅Token和完整链接只显示一次，请立即保存。</p>
			<div class="secret-grid">
				<div class="secret-label">customerId</div><div id="secret-customer-id" class="secret-value"></div>
				<div class="secret-label">UUID</div><div id="secret-uuid" class="secret-value"></div>
				<div class="secret-label">到期时间</div><div id="secret-expires-at" class="secret-value"></div>
				<div class="secret-label">Token</div><div id="secret-token" class="secret-value"></div>
				<div class="secret-label">订阅链接</div><div id="secret-subscription-url" class="secret-value"></div>
			</div>
			<div class="secret-actions"><button id="copy-subscription" type="button">复制订阅链接</button><button id="copy-secret-uuid" class="secondary" type="button">复制UUID</button><button id="copy-token" class="secondary" type="button">复制Token</button><button id="clear-secret" class="danger" type="button">清除凭据</button></div>
		</section>
		<section id="edit-panel" class="panel edit-panel" aria-labelledby="edit-title" hidden>
			<div class="edit-heading"><div><h2 id="edit-title">编辑客户资料</h2><div id="edit-customer-id" class="edit-customer-id"></div></div></div>
			<form id="edit-form" novalidate>
				<div class="create-grid">
					<div class="field"><label for="edit-name">客户名称</label><input id="edit-name" type="text" maxlength="80" autocomplete="off" required></div>
					<div class="field"><label for="edit-remark">备注</label><textarea id="edit-remark" maxlength="500" autocomplete="off"></textarea></div>
				</div>
				<div class="form-actions"><button id="save-edit" type="submit">保存修改</button><button id="cancel-edit" class="secondary" type="button">取消</button></div>
			</form>
		</section>
		<section class="panel" aria-labelledby="stats-title">
			<h2 id="stats-title">当前页面</h2>
			<p class="notice">当前统计仅基于已加载客户</p>
			<div class="stats">
				<div class="stat"><div class="stat-label">已加载</div><div class="stat-value" id="count-loaded">0</div></div>
				<div class="stat"><div class="stat-label">正常</div><div class="stat-value" id="count-normal">0</div></div>
				<div class="stat"><div class="stat-label">已停用</div><div class="stat-value" id="count-disabled">0</div></div>
				<div class="stat"><div class="stat-label">已过期</div><div class="stat-value" id="count-expired">0</div></div>
				<div class="stat"><div class="stat-label">额度用尽</div><div class="stat-value" id="count-quota">0</div></div>
				<div class="stat"><div class="stat-label">待处理</div><div class="stat-value" id="count-pending">0</div></div>
			</div>
		</section>
		<section class="panel" aria-labelledby="customers-title">
			<h2 id="customers-title">客户列表</h2>
			<div class="toolbar">
				<div class="field">
					<label for="search-input">搜索当前已加载客户</label>
					<input id="search-input" type="search" autocomplete="off" placeholder="名称、备注、UUID 或 customerId">
				</div>
				<div class="field">
					<label for="status-filter">状态筛选</label>
					<select id="status-filter">
						<option value="all">全部</option><option value="normal">正常</option><option value="disabled">已停用</option><option value="expired">已过期</option><option value="quota">额度用尽</option><option value="pending">待处理</option>
					</select>
				</div>
			</div>
			<div id="migration-notice" class="migration" role="status" hidden></div>
			<div id="table-wrap" class="table-wrap">
				<table>
					<thead><tr><th>客户名称</th><th>备注</th><th>UUID</th><th>customerId</th><th>状态</th><th>到期时间</th><th>剩余时间</th><th>总流量</th><th>已结算</th><th>剩余流量</th><th>用量更新时间</th><th>结算窗口截止</th><th>创建时间</th><th>Token</th><th>操作</th></tr></thead>
					<tbody id="customer-list"></tbody>
				</table>
			</div>
			<div class="list-footer"><button id="load-more-button" class="secondary" type="button" hidden disabled>加载更多</button></div>
		</section>
		<noscript><p class="panel">此页面需要启用 JavaScript 才能加载客户列表。</p></noscript>
	</main>
	<script nonce="${nonce}">
	(() => {
		'use strict';
		const DAY_MS = 86400000, GIB_BYTES = 1073741824, MAX_QUOTA_GIB = 1000000;
		const customersById = new Map();
		const customerOrder = [];
		const requestedCursors = new Set();
		const customerOperations = new Map();
		let nextCursor = null;
		let listBusy = false;
		let createBusy = false;
		let pendingCreateAttempt = null;
		let editingCustomerId = null;
		let oneTimeSecret = null;
		let requestGeneration = 0;
		let activeController = null;
		let currentPageMigrationRequired = 0;
		const elements = {
			message: document.getElementById('message'), refresh: document.getElementById('refresh-button'), loadMore: document.getElementById('load-more-button'),
			search: document.getElementById('search-input'), filter: document.getElementById('status-filter'), list: document.getElementById('customer-list'),
			tableWrap: document.getElementById('table-wrap'), migration: document.getElementById('migration-notice'),
			adminLink: document.getElementById('admin-link'), createForm: document.getElementById('create-form'), createName: document.getElementById('create-name'), createRemark: document.getElementById('create-remark'), createDuration: document.getElementById('create-duration'), createQuota: document.getElementById('create-quota'), createUnlimited: document.getElementById('create-unlimited'), createButton: document.getElementById('create-button'), quickDays: Array.from(document.querySelectorAll('.quick-day')),
			secretPanel: document.getElementById('secret-panel'), secretCustomerId: document.getElementById('secret-customer-id'), secretUuid: document.getElementById('secret-uuid'), secretExpiresAt: document.getElementById('secret-expires-at'), secretToken: document.getElementById('secret-token'), secretSubscriptionUrl: document.getElementById('secret-subscription-url'), copySubscription: document.getElementById('copy-subscription'), copySecretUuid: document.getElementById('copy-secret-uuid'), copyToken: document.getElementById('copy-token'), clearSecret: document.getElementById('clear-secret'),
			editPanel: document.getElementById('edit-panel'), editForm: document.getElementById('edit-form'), editCustomerId: document.getElementById('edit-customer-id'), editName: document.getElementById('edit-name'), editRemark: document.getElementById('edit-remark'), saveEdit: document.getElementById('save-edit'), cancelEdit: document.getElementById('cancel-edit'),
			counts: { loaded: document.getElementById('count-loaded'), normal: document.getElementById('count-normal'), disabled: document.getElementById('count-disabled'), expired: document.getElementById('count-expired'), quota: document.getElementById('count-quota'), pending: document.getElementById('count-pending') }
		};

		function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
		function hasExactFields(value, fields) {
			if (!isPlainObject(value)) return false;
			const keys = Object.keys(value);
			return keys.length === fields.length && keys.every((key) => fields.includes(key));
		}
		function isValidCustomerTimestamp(value) { return Number.isSafeInteger(value) && value >= 0; }
		function validateCustomer(value) {
			const requiredFields = ['customerId','name','remark','uuid','state','enabled','expiresAt','createdAt','updatedAt','revision','usageRevision','tokenPreview','quotaBytes','settledUsedBytes','remainingBytes','quotaExceeded','usageUpdatedAt','usageSettledThrough','unlimitedTraffic','disableReason','trafficEligible'];
			const allowedFields = [...requiredFields, 'expired'];
			if (!isPlainObject(value) || !requiredFields.every((field) => Object.prototype.hasOwnProperty.call(value, field)) || !Object.keys(value).every((field) => allowedFields.includes(field))) throw new Error('invalid_response');
			if (typeof value.customerId !== 'string' || !/^cus_[A-Za-z0-9_-]{16,128}$/.test(value.customerId)) throw new Error('invalid_response');
			if (typeof value.name !== 'string' || typeof value.remark !== 'string') throw new Error('invalid_response');
			if (typeof value.uuid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.uuid)) throw new Error('invalid_response');
			if (value.state !== 'active' && value.state !== 'pending') throw new Error('invalid_response');
			if (typeof value.enabled !== 'boolean') throw new Error('invalid_response');
			if (!Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isSafeInteger(value.usageRevision) || value.usageRevision < 1) throw new Error('invalid_response');
			if (typeof value.tokenPreview !== 'string' || !/^••••[A-Za-z0-9_-]{4}$/.test(value.tokenPreview)) throw new Error('invalid_response');
			const expiresAtValid = isValidCustomerTimestamp(value.expiresAt);
			const createdAtValid = isValidCustomerTimestamp(value.createdAt);
			const updatedAtValid = isValidCustomerTimestamp(value.updatedAt) && (!createdAtValid || value.updatedAt >= value.createdAt);
			const expired = typeof value.expired === 'boolean' ? value.expired : expiresAtValid ? Date.now() >= value.expiresAt : true;
			const settledValid = Number.isSafeInteger(value.settledUsedBytes) && value.settledUsedBytes >= 0;
			const usageUpdatedAtValid = isValidCustomerTimestamp(value.usageUpdatedAt);
			const usageSettledThroughValid = isValidCustomerTimestamp(value.usageSettledThrough);
			const unlimitedValid = typeof value.unlimitedTraffic === 'boolean';
			const quotaValid = unlimitedValid && (value.unlimitedTraffic === true ? value.quotaBytes === null : Number.isSafeInteger(value.quotaBytes) && value.quotaBytes > 0);
			const expectedQuotaExceeded = quotaValid && settledValid && value.unlimitedTraffic === false && value.settledUsedBytes >= value.quotaBytes;
			const expectedRemaining = quotaValid && settledValid && value.unlimitedTraffic === false ? Math.max(0, value.quotaBytes - value.settledUsedBytes) : null;
			const expectedTrafficEligible = quotaValid && settledValid && (value.unlimitedTraffic === true || value.settledUsedBytes < value.quotaBytes);
			const trafficInvalid = !quotaValid || !settledValid || !usageUpdatedAtValid || !usageSettledThroughValid
				|| typeof value.quotaExceeded !== 'boolean' || value.quotaExceeded !== expectedQuotaExceeded
				|| value.remainingBytes !== expectedRemaining
				|| typeof value.trafficEligible !== 'boolean' || value.trafficEligible !== expectedTrafficEligible
				|| (value.enabled === true
					? value.disableReason !== null
					: value.state === 'active' ? value.disableReason !== 'manual' : value.disableReason !== null);
			return { ...value, expired, timeInvalid: !expiresAtValid || !createdAtValid || !updatedAtValid, trafficInvalid };
		}
		function validateListPayload(value) {
			if (!hasExactFields(value, ['items','cursor','migrationRequired']) || !Array.isArray(value.items)) throw new Error('invalid_response');
			if (value.cursor !== null && typeof value.cursor !== 'string') throw new Error('invalid_response');
			if (!Number.isSafeInteger(value.migrationRequired) || value.migrationRequired < 0) throw new Error('invalid_response');
			return { items: value.items.map(validateCustomer), cursor: value.cursor, migrationRequired: value.migrationRequired };
		}
		function validateCustomerEnvelope(value) {
			if (!hasExactFields(value, ['customer'])) throw new Error('invalid_response');
			return { customer: validateCustomer(value.customer) };
		}
		function validateCreatePayload(value) {
			if (!hasExactFields(value, ['customer','rawToken','subscriptionUrl','secretReturnedOnce']) || value.secretReturnedOnce !== true) throw new Error('invalid_response');
			if (typeof value.rawToken !== 'string' || !/^[A-Za-z0-9_-]{43,512}$/.test(value.rawToken) || typeof value.subscriptionUrl !== 'string' || value.subscriptionUrl.length > 4096) throw new Error('invalid_response');
			let subscriptionUrl;
			try { subscriptionUrl = new URL(value.subscriptionUrl); } catch (_) { throw new Error('invalid_response'); }
			if (subscriptionUrl.origin !== location.origin || subscriptionUrl.pathname !== '/sub' || subscriptionUrl.username || subscriptionUrl.password || subscriptionUrl.hash || subscriptionUrl.searchParams.getAll('token').length !== 1 || subscriptionUrl.searchParams.get('token') !== value.rawToken) throw new Error('invalid_response');
			return { customer: validateCustomer(value.customer), rawToken: value.rawToken, subscriptionUrl: subscriptionUrl.toString(), secretReturnedOnce: true };
		}
		function upsertCustomer(customer) {
			if (!customersById.has(customer.customerId)) customerOrder.push(customer.customerId);
			customersById.set(customer.customerId, customer);
			renderAll();
		}
		function clearOneTimeSecret() {
			if (oneTimeSecret) { oneTimeSecret.rawToken = ''; oneTimeSecret.subscriptionUrl = ''; oneTimeSecret.uuid = ''; }
			oneTimeSecret = null;
			[elements.secretCustomerId,elements.secretUuid,elements.secretExpiresAt,elements.secretToken,elements.secretSubscriptionUrl].forEach((element) => { element.textContent = ''; });
			elements.secretPanel.hidden = true;
		}
		function showOneTimeSecret(payload) {
			clearOneTimeSecret();
			oneTimeSecret = { customerId: payload.customer.customerId, uuid: payload.customer.uuid, expiresAt: payload.customer.expiresAt, rawToken: payload.rawToken, subscriptionUrl: payload.subscriptionUrl };
			elements.secretCustomerId.textContent = oneTimeSecret.customerId;
			elements.secretUuid.textContent = oneTimeSecret.uuid;
			elements.secretExpiresAt.textContent = formatLocalTime(oneTimeSecret.expiresAt);
			elements.secretToken.textContent = oneTimeSecret.rawToken;
			elements.secretSubscriptionUrl.textContent = oneTimeSecret.subscriptionUrl;
			elements.secretPanel.hidden = false;
		}
		function mutationErrorMessage(status, payload) {
			const code = isPlainObject(payload?.error) && typeof payload.error.code === 'string' ? payload.error.code : '';
			if (status === 400) return '请求内容有误，请检查后重试';
			if (status === 403) return '安全校验失败，请刷新页面后重试';
			if (status === 404) return '客户不存在或已被删除';
			if (status === 405) return '页面与服务端版本不匹配';
			if (status === 409 && code === 'customer_pending') return '客户尚未激活';
			if (status === 409 && code === 'migration_required') return '该记录需要迁移';
			if (status === 409 && code === 'quota_unlimited') return '不限流量客户无需增加额度，请先设置有限额度';
			if (status === 409 && code === 'create_in_progress') return '客户正在创建中，请稍后使用相同表单重试';
			if (status === 409 && code === 'idempotency_conflict') return '本次创建请求已失效，请修改表单后重试';
			if (status === 409 && code === 'revision_conflict') return '客户资料已被其他操作更新，请刷新列表后重试';
			if (status === 409) return '客户状态冲突，请刷新列表后重试';
			if (status === 413) return '请求内容过大';
			if (status === 415) return '请求格式异常';
			if (status === 500 || status === 503) return '服务暂时异常，请稍后重试';
			return '操作失败，请稍后重试';
		}
		function safeMutationErrorMessage(error) {
			const allowed = new Set(['请求内容有误，请检查后重试','安全校验失败，请刷新页面后重试','客户不存在或已被删除','页面与服务端版本不匹配','客户尚未激活','该记录需要迁移','不限流量客户无需增加额度，请先设置有限额度','客户正在创建中，请稍后使用相同表单重试','本次创建请求已失效，请修改表单后重试','客户资料已被其他操作更新，请刷新列表后重试','客户状态冲突，请刷新列表后重试','请求内容过大','请求格式异常','服务暂时异常，请稍后重试','操作失败，请稍后重试','服务返回的数据格式异常，请稍后重试']);
			return allowed.has(error?.message) ? error.message : '操作失败，请稍后重试';
		}
		function handleUnauthorized() {
			clearOneTimeSecret();
			customerOperations.clear();
			createBusy = false;
			pendingCreateAttempt = null;
			closeEditPanel();
			clearCustomerState();
			window.location.href = '/login';
		}
		async function mutationRequest(path, method, body, expectedStatus, validator) {
			const response = await fetch(path, {
				method,
				credentials: 'same-origin',
				headers: { 'Content-Type':'application/json', 'X-Admin-Request':'1' },
				body: JSON.stringify(body),
			});
			if (response.status === 401) { handleUnauthorized(); throw new Error('redirecting'); }
			const contentType = response.headers.get('Content-Type') || '';
			const isJson = contentType.toLowerCase().includes('application/json');
			let payload = null;
			if (isJson) {
				try { payload = await response.json(); } catch (_) { throw new Error(mutationErrorMessage(response.status, null)); }
			}
			if (!response.ok) throw new Error(mutationErrorMessage(response.status, payload));
			if (!isJson || response.status !== expectedStatus) throw new Error('服务返回的数据格式异常，请稍后重试');
			try { return validator(payload); } catch (_) { throw new Error('服务返回的数据格式异常，请稍后重试'); }
		}
		async function copyTextSafely(value, successMessage) {
			if (typeof value !== 'string' || value.length === 0) { showMessage('复制失败，请手动复制', 'error'); return; }
			try {
				if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('clipboard_unavailable');
				await navigator.clipboard.writeText(value);
				showMessage(successMessage, 'info');
				return;
			} catch (_) { }
			let textarea = null;
			try {
				textarea = document.createElement('textarea');
				textarea.readOnly = true;
				textarea.value = value;
				textarea.setAttribute('aria-hidden', 'true');
				textarea.className = 'clipboard-fallback';
				document.body.appendChild(textarea);
				textarea.select();
				if (!document.execCommand('copy')) throw new Error('copy_failed');
				showMessage(successMessage, 'info');
			} catch (_) {
				showMessage('复制失败，请手动复制', 'error');
			} finally {
				if (textarea) { textarea.value = ''; textarea.remove(); }
			}
		}
		function clearMessage() { elements.message.hidden = true; elements.message.textContent = ''; elements.message.className = 'message'; }
		function showMessage(text, type) { elements.message.textContent = text; elements.message.className = 'message ' + (type === 'info' ? 'info' : 'error'); elements.message.hidden = false; }
		function statusOf(customer) {
			if (customer.timeInvalid || customer.trafficInvalid) return 'pending';
			if (customer.state !== 'active') return 'pending';
			if (customer.enabled === false) return 'disabled';
			if (customer.expired === true) return 'expired';
			if (customer.trafficEligible === false) return 'quota';
			return 'normal';
		}
		function statusLabel(status) { return { normal:'正常', disabled:'已停用', expired:'已过期', quota:'额度用尽', pending:'待处理' }[status] || '待处理'; }
		function formatLocalTime(value) {
			if (!isValidCustomerTimestamp(value)) return '时间异常';
			const date = new Date(value);
			return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle:'medium', timeStyle:'short' }).format(date) : '时间异常';
		}
		function formatRemaining(value) {
			if (!isValidCustomerTimestamp(value)) return '时间异常';
			const delta = value - Date.now();
			if (delta > 0 && delta < DAY_MS) return '剩余不足1天';
			if (delta > 0) return '剩余 ' + Math.ceil(delta / DAY_MS) + ' 天';
			return '已过期 ' + Math.floor(Math.abs(delta) / DAY_MS) + ' 天';
		}
		function formatTrafficBytes(value) {
			if (!Number.isSafeInteger(value) || value < 0) return '流量异常';
			const gib = value / GIB_BYTES;
			return (gib >= 100 ? gib.toFixed(0) : gib >= 10 ? gib.toFixed(1) : gib.toFixed(2)).replace(/\.0+$/, '') + ' GiB';
		}
		function formatUsageUpdatedAt(value) {
			return value === 0 ? '尚未结算' : formatLocalTime(value);
		}
		function validateEditableFields(nameValue, remarkValue) {
			const name = nameValue.trim(), remark = remarkValue;
			if (Array.from(name).length < 1 || Array.from(name).length > 80 || /[\\u0000-\\u001f\\u007f-\\u009f]/.test(name)) throw new Error('客户名称不能为空，且不能包含控制字符');
			if (Array.from(remark).length > 500 || /[\\u0000-\\u001f\\u007f-\\u009f]/.test(remark)) throw new Error('备注不能超过500个字符或包含控制字符');
			return { name, remark };
		}
		function validateDurationDays(value) {
			const text = String(value).trim();
			if (!/^\\d+$/.test(text)) throw new Error('套餐天数必须是正整数');
			const durationDays = Number(text);
			if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650) throw new Error('套餐天数必须是1到3650之间的整数');
			return durationDays;
		}
		function validateQuotaGiB(value) {
			const text = String(value).trim();
			if (text.length === 0) throw new Error('流量额度不能为空');
			if (!/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(text)) throw new Error('流量额度必须是数字 GiB');
			const quotaGiB = Number(text);
			if (!Number.isFinite(quotaGiB)) throw new Error('流量额度必须是有限数字 GiB');
			if (!Number.isInteger(quotaGiB)) throw new Error('流量额度必须是整数 GiB');
			if (!Number.isSafeInteger(quotaGiB)) throw new Error('流量额度超出安全整数范围');
			if (quotaGiB <= 0) throw new Error('流量额度必须大于0 GiB');
			if (quotaGiB > MAX_QUOTA_GIB) throw new Error('流量额度不能超过1000000 GiB');
			return quotaGiB;
		}
		function validateUsedGiB(value) {
			const text = String(value).trim();
			if (text.length === 0) throw new Error('已用流量不能为空');
			if (!/^[+]?[0-9]+$/.test(text)) throw new Error('已用流量必须是非负整数 GiB');
			const usedGiB = Number(text);
			if (!Number.isSafeInteger(usedGiB) || usedGiB < 0 || usedGiB > Math.floor(Number.MAX_SAFE_INTEGER / GIB_BYTES)) throw new Error('已用流量超出安全范围');
			return usedGiB;
		}

		function generateCreateIdempotencyKey() {
			if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
			const bytes = crypto.getRandomValues(new Uint8Array(24));
			return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
		}
		function setCreateBusy(busy) {
			createBusy = busy;
			elements.createButton.disabled = busy;
			elements.createName.disabled = busy;
			elements.createRemark.disabled = busy;
			elements.createDuration.disabled = busy;
			elements.createQuota.disabled = busy || elements.createUnlimited.checked;
			elements.createQuota.required = !elements.createUnlimited.checked;
			elements.createUnlimited.disabled = busy;
			elements.quickDays.forEach((button) => { button.disabled = busy; });
			elements.refresh.disabled = listBusy || createBusy || customerOperations.size > 0;
		}
		function closeEditPanel() {
			editingCustomerId = null;
			elements.editCustomerId.textContent = '';
			elements.editName.value = '';
			elements.editRemark.value = '';
			elements.editPanel.hidden = true;
		}
		function openEditPanel(customerId) {
			const customer = customersById.get(customerId);
			if (!customer || customerOperations.has(customerId)) return;
			editingCustomerId = customerId;
			elements.editCustomerId.textContent = customer.customerId;
			elements.editName.value = customer.name;
			elements.editRemark.value = customer.remark;
			elements.editPanel.hidden = false;
			elements.editName.focus();
		}
		function updateEditControls() {
			const busy = editingCustomerId !== null && customerOperations.has(editingCustomerId);
			elements.saveEdit.disabled = busy;
			elements.cancelEdit.disabled = busy;
			elements.editName.disabled = busy;
			elements.editRemark.disabled = busy;
		}
		function createTextCell(label, value, className) {
			const cell = document.createElement('td');
			cell.setAttribute('data-label', label);
			if (className) cell.className = className;
			cell.textContent = value;
			return cell;
		}
		function createStatusCell(customer) {
			const cell = document.createElement('td');
			cell.setAttribute('data-label', '状态');
			const status = statusOf(customer);
			const badge = document.createElement('span');
			badge.className = 'status ' + status;
			badge.textContent = statusLabel(status);
			cell.appendChild(badge);
			if (customer.timeInvalid || customer.trafficInvalid || status === 'disabled' && (customer.expired || customer.quotaExceeded) || status === 'expired' && customer.quotaExceeded) {
				const note = document.createElement('span');
				note.className = 'status-note';
				note.textContent = customer.timeInvalid ? '时间异常' : customer.trafficInvalid ? '流量数据异常' : customer.expired && customer.quotaExceeded ? '同时已过期且额度用尽' : customer.expired ? '同时已过期' : '同时额度用尽';
				cell.appendChild(note);
			}
			return cell;
		}
		function createActionButton(label, className, disabled, handler) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'small' + (className ? ' ' + className : '');
			button.textContent = label;
			button.disabled = disabled;
			button.addEventListener('click', handler);
			return button;
		}
		function createActionsCell(customer) {
			const cell = document.createElement('td');
			cell.setAttribute('data-label', '操作');
			const actions = document.createElement('div');
			actions.className = 'customer-actions';
			const busy = customerOperations.has(customer.customerId);
			actions.appendChild(createActionButton('编辑', 'secondary', busy, () => openEditPanel(customer.customerId)));
			if (customer.state === 'active' && !customer.timeInvalid) {
				actions.appendChild(createActionButton('续费30天', 'secondary', busy, () => { void renewCustomer(customer.customerId, 30); }));
				actions.appendChild(createActionButton('续费90天', 'secondary', busy, () => { void renewCustomer(customer.customerId, 90); }));
				actions.appendChild(createActionButton('自定义续费', 'secondary', busy, () => { void renewCustomerCustom(customer.customerId); }));
				const targetEnabled = !customer.enabled;
				actions.appendChild(createActionButton(targetEnabled ? '启用' : '停用', targetEnabled ? 'secondary' : 'danger', busy, () => { void toggleCustomer(customer.customerId, targetEnabled); }));
				if (!customer.trafficInvalid) {
					actions.appendChild(createActionButton('设置额度', 'secondary', busy, () => { void setCustomerQuota(customer.customerId); }));
					if (!customer.unlimitedTraffic) actions.appendChild(createActionButton('增加流量', 'secondary', busy, () => { void addCustomerQuota(customer.customerId); }));
					if (!customer.unlimitedTraffic) actions.appendChild(createActionButton('设为不限量', 'secondary', busy, () => { void setCustomerUnlimited(customer.customerId); }));
					actions.appendChild(createActionButton('清零已用', 'danger', busy, () => { void resetCustomerUsage(customer.customerId); }));
														actions.appendChild(createActionButton('校正已用', 'danger', busy, () => { void setCustomerUsedTraffic(customer.customerId); }));
				}
			}
			actions.appendChild(createActionButton('复制UUID', 'secondary', false, () => { void copyTextSafely(customer.uuid, 'UUID已复制'); }));
			cell.appendChild(actions);
			return cell;
		}
		function renderStats() {
			const counts = { normal:0, disabled:0, expired:0, quota:0, pending:0 };
			customerOrder.forEach((customerId) => { const customer = customersById.get(customerId); if (customer) counts[statusOf(customer)] += 1; });
			elements.counts.loaded.textContent = String(customersById.size);
			elements.counts.normal.textContent = String(counts.normal);
			elements.counts.disabled.textContent = String(counts.disabled);
			elements.counts.expired.textContent = String(counts.expired);
			elements.counts.quota.textContent = String(counts.quota);
			elements.counts.pending.textContent = String(counts.pending);
		}
		function renderMigrationNotice() {
			if (currentPageMigrationRequired > 0) {
				elements.migration.textContent = '当前页有 ' + currentPageMigrationRequired + ' 条旧会员记录需要迁移，已暂不显示。';
				elements.migration.hidden = false;
			} else { elements.migration.textContent = ''; elements.migration.hidden = true; }
		}
		function visibleCustomers() {
			const query = elements.search.value.trim().toLocaleLowerCase();
			const filter = elements.filter.value;
			return customerOrder.map((customerId) => customersById.get(customerId)).filter(Boolean).filter((customer) => {
				if (filter !== 'all' && statusOf(customer) !== filter) return false;
				return !query || [customer.name,customer.remark,customer.uuid,customer.customerId].some((value) => value.toLocaleLowerCase().includes(query));
			});
		}
		function renderCustomers() {
			const fragment = document.createDocumentFragment();
			const customers = visibleCustomers();
			if (customers.length === 0) {
				const row = document.createElement('tr');
				const cell = createTextCell('', listBusy ? '正在加载客户列表…' : '当前没有符合条件的客户', 'empty');
				cell.colSpan = 15;
				row.appendChild(cell);
				fragment.appendChild(row);
			} else customers.forEach((customer) => {
				const row = document.createElement('tr');
				row.appendChild(createTextCell('客户名称', customer.name, 'wrap-value'));
				row.appendChild(createTextCell('备注', customer.remark || '—', 'wrap-value muted'));
				row.appendChild(createTextCell('UUID', customer.uuid, 'wrap-value'));
				row.appendChild(createTextCell('customerId', customer.customerId, 'wrap-value'));
				row.appendChild(createStatusCell(customer));
				row.appendChild(createTextCell('到期时间', formatLocalTime(customer.expiresAt)));
				row.appendChild(createTextCell('剩余时间', formatRemaining(customer.expiresAt)));
				row.appendChild(createTextCell('总流量', customer.trafficInvalid ? '流量异常' : customer.unlimitedTraffic ? '不限流量' : formatTrafficBytes(customer.quotaBytes)));
				row.appendChild(createTextCell('已结算', customer.trafficInvalid ? '流量异常' : formatTrafficBytes(customer.settledUsedBytes)));
				row.appendChild(createTextCell('剩余流量', customer.trafficInvalid ? '流量异常' : customer.unlimitedTraffic ? '不限流量' : formatTrafficBytes(customer.remainingBytes)));
				row.appendChild(createTextCell('用量更新时间', customer.trafficInvalid ? '时间异常' : formatUsageUpdatedAt(customer.usageUpdatedAt)));
				row.appendChild(createTextCell('结算窗口截止', customer.trafficInvalid ? '时间异常' : formatUsageUpdatedAt(customer.usageSettledThrough)));
				row.appendChild(createTextCell('创建时间', formatLocalTime(customer.createdAt)));
				row.appendChild(createTextCell('Token', customer.tokenPreview));
				row.appendChild(createActionsCell(customer));
				fragment.appendChild(row);
			});
			elements.list.replaceChildren(fragment);
		}
		function updateLoadMoreButton() {
			const available = typeof nextCursor === 'string' && nextCursor.length > 0 && !requestedCursors.has(nextCursor);
			elements.loadMore.hidden = !available;
			elements.loadMore.disabled = listBusy || !available;
		}
		function renderAll() {
			renderStats(); renderMigrationNotice(); renderCustomers(); updateLoadMoreButton();
			setCreateBusy(createBusy);
			updateEditControls();
			elements.refresh.disabled = listBusy || createBusy || customerOperations.size > 0;
			elements.tableWrap.classList.toggle('loading', listBusy);
		}
		function clearCustomerState() {
			customersById.clear(); customerOrder.length = 0; nextCursor = null; requestedCursors.clear(); currentPageMigrationRequired = 0; renderAll();
		}
		function errorMessageForStatus(status) {
			if (status === 403) return '安全校验失败，请刷新页面后重试';
			if (status === 404) return '接口不存在或页面与服务端版本不匹配';
			if (status === 405) return '页面与服务端版本不匹配';
			if (status === 409) return '存在需要迁移或待处理的客户记录';
			if (status === 413) return '请求内容过大';
			if (status === 415) return '请求格式异常';
			if (status === 500 || status === 503) return '服务暂时异常，请稍后重试';
			return '客户列表加载失败，请稍后重试';
		}
		function safeErrorMessage(error) {
			const allowed = new Set([
				'安全校验失败，请刷新页面后重试', '接口不存在或页面与服务端版本不匹配', '页面与服务端版本不匹配',
				'存在需要迁移或待处理的客户记录', '请求内容过大', '请求格式异常', '服务暂时异常，请稍后重试',
				'客户列表加载失败，请稍后重试', '服务返回的数据格式异常，请稍后重试'
			]);
			return allowed.has(error?.message) ? error.message : '客户列表加载失败，请稍后重试';
		}
		async function parseListResponse(response) {
			if (response.status === 401) {
				handleUnauthorized();
				throw new Error('redirecting');
			}
			const contentType = response.headers.get('Content-Type') || '';
			if (!contentType.toLowerCase().includes('application/json')) throw new Error(errorMessageForStatus(response.status));
			let payload;
			try { payload = await response.json(); } catch (_) { throw new Error(errorMessageForStatus(response.status)); }
			if (!response.ok) throw new Error(errorMessageForStatus(response.status));
			try { return validateListPayload(payload); } catch (_) { throw new Error('服务返回的数据格式异常，请稍后重试'); }
		}
		async function createCustomer(event) {
			event.preventDefault();
			if (createBusy) return;
			let fields, durationDays, quotaGiB;
			try {
				fields = validateEditableFields(elements.createName.value, elements.createRemark.value);
				durationDays = validateDurationDays(elements.createDuration.value);
				if (!elements.createUnlimited.checked) quotaGiB = validateQuotaGiB(elements.createQuota.value);
			} catch (error) {
				showMessage(error.message, 'error');
				return;
			}
			clearOneTimeSecret();
			clearMessage();
			setCreateBusy(true);
			try {
				const trafficPlan = elements.createUnlimited.checked ? { unlimitedTraffic:true } : { quotaGiB };
				const createPayload = { name:fields.name, remark:fields.remark, durationDays, ...trafficPlan };
				const requestFingerprint = JSON.stringify(createPayload);
				if (!pendingCreateAttempt || pendingCreateAttempt.requestFingerprint !== requestFingerprint) {
					pendingCreateAttempt = { requestFingerprint, idempotencyKey:generateCreateIdempotencyKey() };
				}
				const created = await mutationRequest('/admin/api/customers', 'POST', { ...createPayload, idempotencyKey:pendingCreateAttempt.idempotencyKey }, 201, validateCreatePayload);
				upsertCustomer(created.customer);
				showOneTimeSecret(created);
				elements.createForm.reset();
				elements.createDuration.value = '30';
				elements.createQuota.value = '100';
				showMessage('客户创建成功，请立即保存一次性订阅凭据', 'info');
				pendingCreateAttempt = null;
			} catch (error) {
				if (error.message !== 'redirecting') showMessage(safeMutationErrorMessage(error), 'error');
			} finally {
				setCreateBusy(false);
				renderAll();
			}
		}
		async function saveCustomerEdit(event) {
			event.preventDefault();
			const customerId = editingCustomerId, customer = customerId ? customersById.get(customerId) : null;
			if (!customer || customerOperations.has(customerId)) return;
			let fields;
			try { fields = validateEditableFields(elements.editName.value, elements.editRemark.value); }
			catch (error) { showMessage(error.message, 'error'); return; }
			const body = {};
			if (fields.name !== customer.name) body.name = fields.name;
			if (fields.remark !== customer.remark) body.remark = fields.remark;
			if (Object.keys(body).length === 0) { showMessage('名称和备注没有变化', 'info'); return; }
			body.expectedRevision = customer.revision;
			customerOperations.set(customerId, 'edit');
			clearMessage();
			renderAll();
			try {
				const result = await mutationRequest('/admin/api/customers/' + encodeURIComponent(customerId), 'PATCH', body, 200, validateCustomerEnvelope);
				upsertCustomer(result.customer);
				closeEditPanel();
				showMessage('客户资料已更新', 'info');
			} catch (error) {
				if (error.message !== 'redirecting') showMessage(safeMutationErrorMessage(error), 'error');
			} finally {
				customerOperations.delete(customerId);
				renderAll();
			}
		}
		async function renewCustomer(customerId, durationDays) {
			const customer = customersById.get(customerId);
			if (!customer || customer.state !== 'active' || customer.timeInvalid || customerOperations.has(customerId)) return;
			if (!window.confirm('确定为该客户续费' + durationDays + '天吗？')) return;
			customerOperations.set(customerId, 'renew');
			clearMessage();
			renderAll();
			try {
				const result = await mutationRequest('/admin/api/customers/' + encodeURIComponent(customerId) + '/renew', 'POST', { durationDays, expectedRevision:customer.revision }, 200, validateCustomerEnvelope);
				upsertCustomer(result.customer);
				showMessage('续费成功', 'info');
			} catch (error) {
				if (error.message !== 'redirecting') showMessage(safeMutationErrorMessage(error), 'error');
			} finally {
				customerOperations.delete(customerId);
				renderAll();
			}
		}
		async function renewCustomerCustom(customerId) {
			const value = window.prompt('请输入续费天数（1-3650）', '30');
			if (value === null) return;
			let durationDays;
			try { durationDays = validateDurationDays(value); }
			catch (error) { showMessage(error.message, 'error'); return; }
			await renewCustomer(customerId, durationDays);
		}
		async function mutateCustomerTraffic(customerId, operation, pathSuffix, body, confirmMessage, successMessage, revisionField = 'expectedRevision') {
			const customer = customersById.get(customerId);
			if (!customer || customer.state !== 'active' || customer.timeInvalid || customer.trafficInvalid || customerOperations.has(customerId)) return;
			if (!window.confirm(confirmMessage)) return;
			customerOperations.set(customerId, operation);
			clearMessage();
			renderAll();
			try {
				const mutationBody = { ...body, [revisionField]: customer.usageRevision };
																const result = await mutationRequest('/admin/api/customers/' + encodeURIComponent(customerId) + '/' + pathSuffix, 'POST', mutationBody, 200, validateCustomerEnvelope);
				upsertCustomer(result.customer);
				showMessage(successMessage, 'info');
			} catch (error) {
				if (error.message !== 'redirecting') showMessage(safeMutationErrorMessage(error) + '，原状态已保留，必要时请刷新列表确认', 'error');
			} finally {
				customerOperations.delete(customerId);
				renderAll();
			}
		}
		async function setCustomerQuota(customerId) {
			const customer = customersById.get(customerId);
			if (!customer || customer.trafficInvalid) return;
			const currentGiB = customer.unlimitedTraffic ? '100' : String(Math.max(1, Math.ceil(customer.quotaBytes / GIB_BYTES)));
			const value = window.prompt('请输入新的总流量额度（GiB，1-1000000）', currentGiB);
			if (value === null) return;
			let quotaGiB;
			try { quotaGiB = validateQuotaGiB(value); }
			catch (error) { showMessage(error.message, 'error'); return; }
			await mutateCustomerTraffic(customerId, 'set-quota', 'quota', { quotaGiB }, '确定将该客户总流量额度设置为 ' + quotaGiB + ' GiB 吗？管理员手动停用状态不会改变。', '流量额度已更新');
		}
		async function addCustomerQuota(customerId) {
			const value = window.prompt('请输入需要增加的流量（GiB，1-1000000）', '100');
			if (value === null) return;
			let quotaGiB;
			try { quotaGiB = validateQuotaGiB(value); }
			catch (error) { showMessage(error.message, 'error'); return; }
			await mutateCustomerTraffic(customerId, 'add-quota', 'add-quota', { quotaGiB }, '确定为该客户增加 ' + quotaGiB + ' GiB 流量吗？管理员手动停用状态不会改变。', '流量额度已增加');
		}
		async function setCustomerUnlimited(customerId) {
			await mutateCustomerTraffic(customerId, 'set-unlimited', 'quota', { unlimitedTraffic:true }, '确定将该客户设置为不限流量吗？管理员手动停用状态不会改变。', '已设置为不限流量');
		}
		async function setCustomerUsedTraffic(customerId) {
			const customer = customersById.get(customerId);
			if (!customer || customer.timeInvalid || customer.trafficInvalid || customerOperations.has(customerId)) return;
			const currentGiB = Math.floor(customer.settledUsedBytes / GIB_BYTES);
			const value = window.prompt('请输入校正后的已用流量（GiB，非负整数）', String(currentGiB));
			if (value === null) return;
			let usedGiB;
			try { usedGiB = validateUsedGiB(value); }
			catch (error) { showMessage(error.message, 'error'); return; }
			await mutateCustomerTraffic(customerId, 'set-used-traffic', 'set-used-traffic', { usedGiB }, '该操作会直接影响客户剩余流量及连接资格。确定继续吗？', '已用流量已校正', 'expectedUsageRevision');
		}

		async function resetCustomerUsage(customerId) {
			await mutateCustomerTraffic(customerId, 'reset-usage', 'reset-usage', { confirm:true }, '确定清零该客户的已结算流量吗？此操作不会自动启用已手动停用的客户。', '已结算流量已清零');
		}
		async function toggleCustomer(customerId, enabled) {
			const customer = customersById.get(customerId);
			if (!customer || customer.state !== 'active' || customer.timeInvalid || customerOperations.has(customerId) || typeof enabled !== 'boolean') return;
			if (!window.confirm(enabled ? '确定启用该客户吗？' : '确定停用该客户吗？')) return;
			customerOperations.set(customerId, 'toggle');
			clearMessage();
			renderAll();
			try {
				const result = await mutationRequest('/admin/api/customers/' + encodeURIComponent(customerId) + '/toggle', 'POST', { enabled, expectedRevision:customer.revision }, 200, validateCustomerEnvelope);
				upsertCustomer(result.customer);
				showMessage(enabled ? '客户已启用' : '客户已停用', 'info');
			} catch (error) {
				if (error.message !== 'redirecting') showMessage(safeMutationErrorMessage(error) + '，原状态已保留，必要时请刷新列表确认', 'error');
			} finally {
				customerOperations.delete(customerId);
				renderAll();
			}
		}
		async function loadPage(cursor, generation) {
			if (listBusy) return;
			if (cursor !== null && (typeof cursor !== 'string' || cursor.length === 0 || requestedCursors.has(cursor))) return;
			listBusy = true;
			if (cursor !== null) requestedCursors.add(cursor);
			const controller = new AbortController();
			activeController = controller;
			clearMessage();
			renderAll();
			try {
				let apiUrl = '/admin/api/customers?limit=50';
				if (cursor !== null) apiUrl += '&cursor=' + encodeURIComponent(cursor);
				const response = await fetch(apiUrl, { method:'GET', credentials:'same-origin', signal:controller.signal });
				const page = await parseListResponse(response);
				if (generation !== requestGeneration || controller.signal.aborted) return;
				page.items.forEach((customer) => {
					if (!customersById.has(customer.customerId)) customerOrder.push(customer.customerId);
					customersById.set(customer.customerId, customer);
				});
				nextCursor = page.cursor;
				currentPageMigrationRequired = page.migrationRequired;
			} catch (error) {
				if (cursor !== null) requestedCursors.delete(cursor);
				if (generation === requestGeneration && !controller.signal.aborted && error.message !== 'redirecting') showMessage(safeErrorMessage(error), 'error');
			} finally {
				if (generation === requestGeneration) {
					listBusy = false;
					if (activeController === controller) activeController = null;
					renderAll();
				}
			}
		}
		function refreshCustomers() {
			requestGeneration += 1;
			if (activeController) activeController.abort();
			activeController = null;
			listBusy = false;
			clearOneTimeSecret();
			customerOperations.clear();
			setCreateBusy(false);
			closeEditPanel();
			clearMessage();
			clearCustomerState();
			void loadPage(null, requestGeneration);
		}
		elements.createForm.addEventListener('submit', (event) => { void createCustomer(event); });
		elements.editForm.addEventListener('submit', (event) => { void saveCustomerEdit(event); });
		elements.cancelEdit.addEventListener('click', closeEditPanel);
		elements.quickDays.forEach((button) => {
			button.addEventListener('click', () => {
				if (createBusy) return;
				elements.createDuration.value = button.dataset.days || '30';
				elements.createQuota.value = button.dataset.quota || '100';
				elements.createUnlimited.checked = false;
				elements.createQuota.disabled = false;
				elements.createQuota.required = true;
			});
		});
		elements.createUnlimited.addEventListener('change', () => {
			elements.createQuota.disabled = createBusy || elements.createUnlimited.checked;
			elements.createQuota.required = !elements.createUnlimited.checked;
		});
		elements.copySubscription.addEventListener('click', () => { void copyTextSafely(oneTimeSecret?.subscriptionUrl || '', '订阅链接已复制'); });
		elements.copySecretUuid.addEventListener('click', () => { void copyTextSafely(oneTimeSecret?.uuid || '', 'UUID已复制'); });
		elements.copyToken.addEventListener('click', () => { void copyTextSafely(oneTimeSecret?.rawToken || '', 'Token已复制'); });
		elements.clearSecret.addEventListener('click', clearOneTimeSecret);
		elements.adminLink.addEventListener('click', clearOneTimeSecret);
		window.addEventListener('pagehide', clearOneTimeSecret);
		window.addEventListener('pageshow', (event) => { if (event.persisted) clearOneTimeSecret(); });
		elements.refresh.addEventListener('click', refreshCustomers);
		elements.loadMore.addEventListener('click', () => {
			if (typeof nextCursor === 'string' && nextCursor.length > 0 && !requestedCursors.has(nextCursor)) void loadPage(nextCursor, requestGeneration);
		});
		elements.search.addEventListener('input', renderCustomers);
		elements.filter.addEventListener('change', renderCustomers);
		refreshCustomers();
	})();
	</script>
</body></html>`;
	return new Response(html, {
		status: 200,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
			'Referrer-Policy': 'no-referrer',
			'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; font-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`,
		},
	});
}
