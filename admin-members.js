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
		.stats { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:.75rem }
		.stat { border:1px solid #e1e7f0; border-radius:12px; padding:.85rem; background:#fbfcfe }
		.stat-label { color:#617087; font-size:.82rem } .stat-value { margin-top:.25rem; font-size:1.45rem; font-weight:750 }
		.toolbar { display:grid; grid-template-columns:minmax(220px,1fr) minmax(150px,230px); gap:.8rem; align-items:end }
		.field { display:grid; gap:.35rem } .field label { color:#43516a; font-size:.9rem; font-weight:650 }
		.field input,.field select { width:100%; min-height:44px; border:1px solid #cbd5e3; border-radius:10px; background:#fff; color:#172033; padding:.65rem .75rem }
		.migration { margin-top:.85rem; color:#704d00; background:#fff8df; border:1px solid #eed68c; border-radius:10px; padding:.75rem }
		.table-wrap { overflow-x:auto } table { width:100%; border-collapse:collapse; min-width:1150px }
		th,td { padding:.75rem .6rem; border-bottom:1px solid #e5eaf1; text-align:left; vertical-align:top } th { color:#536176; background:#f8fafc; font-size:.82rem; white-space:nowrap } td { font-size:.9rem }
		.wrap-value { overflow-wrap:anywhere; word-break:break-word } .muted { color:#6a778b }
		.status { display:inline-flex; border-radius:999px; padding:.26rem .56rem; font-size:.78rem; font-weight:700; white-space:nowrap }
		.status.normal { color:#17613b; background:#e8f7ef } .status.disabled { color:#7b3c00; background:#fff1df } .status.expired { color:#8e1c25; background:#ffecef } .status.pending { color:#55429a; background:#f1edff }
		.status-note { display:block; margin-top:.3rem; font-size:.75rem; color:#8e1c25 } .empty { text-align:center; padding:2rem 1rem; color:#647187 }
		.list-footer { display:flex; justify-content:center; padding-top:1rem } .loading { opacity:.65 }
		@media (max-width:980px) { .stats { grid-template-columns:repeat(3,minmax(0,1fr)) } }
		@media (max-width:760px) {
			.page { padding:.8rem } .topbar { align-items:flex-start; flex-direction:column } .topbar-actions { width:100% } .topbar-actions>* { flex:1 1 130px }
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
				<a class="button-link secondary" href="/admin">返回原后台</a>
				<button id="refresh-button" type="button">刷新列表</button>
			</div>
		</header>
		<div id="message" class="message" role="status" aria-live="polite" hidden></div>
		<section class="panel" aria-labelledby="stats-title">
			<h2 id="stats-title">当前页面</h2>
			<p class="notice">当前统计仅基于已加载客户</p>
			<div class="stats">
				<div class="stat"><div class="stat-label">已加载</div><div class="stat-value" id="count-loaded">0</div></div>
				<div class="stat"><div class="stat-label">正常</div><div class="stat-value" id="count-normal">0</div></div>
				<div class="stat"><div class="stat-label">已停用</div><div class="stat-value" id="count-disabled">0</div></div>
				<div class="stat"><div class="stat-label">已过期</div><div class="stat-value" id="count-expired">0</div></div>
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
						<option value="all">全部</option><option value="normal">正常</option><option value="disabled">已停用</option><option value="expired">已过期</option><option value="pending">待处理</option>
					</select>
				</div>
			</div>
			<div id="migration-notice" class="migration" role="status" hidden></div>
			<div id="table-wrap" class="table-wrap">
				<table>
					<thead><tr><th>客户名称</th><th>备注</th><th>UUID</th><th>customerId</th><th>状态</th><th>到期时间</th><th>剩余时间</th><th>创建时间</th><th>Token</th><th>操作</th></tr></thead>
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
		const DAY_MS = 86400000;
		const customersById = new Map();
		const customerOrder = [];
		const requestedCursors = new Set();
		let nextCursor = null;
		let listBusy = false;
		let requestGeneration = 0;
		let activeController = null;
		let currentPageMigrationRequired = 0;
		const elements = {
			message: document.getElementById('message'), refresh: document.getElementById('refresh-button'), loadMore: document.getElementById('load-more-button'),
			search: document.getElementById('search-input'), filter: document.getElementById('status-filter'), list: document.getElementById('customer-list'),
			tableWrap: document.getElementById('table-wrap'), migration: document.getElementById('migration-notice'),
			counts: { loaded: document.getElementById('count-loaded'), normal: document.getElementById('count-normal'), disabled: document.getElementById('count-disabled'), expired: document.getElementById('count-expired'), pending: document.getElementById('count-pending') }
		};

		function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
		function hasExactFields(value, fields) {
			if (!isPlainObject(value)) return false;
			const keys = Object.keys(value);
			return keys.length === fields.length && keys.every((key) => fields.includes(key));
		}
		function isValidCustomerTimestamp(value) { return Number.isSafeInteger(value) && value >= 0; }
		function validateCustomer(value) {
			const requiredFields = ['customerId','name','remark','uuid','state','enabled','expiresAt','createdAt','updatedAt','tokenPreview'];
			const allowedFields = [...requiredFields, 'expired'];
			if (!isPlainObject(value) || !requiredFields.every((field) => Object.prototype.hasOwnProperty.call(value, field)) || !Object.keys(value).every((field) => allowedFields.includes(field))) throw new Error('invalid_response');
			if (typeof value.customerId !== 'string' || !/^cus_[A-Za-z0-9_-]{16,128}$/.test(value.customerId)) throw new Error('invalid_response');
			if (typeof value.name !== 'string' || typeof value.remark !== 'string') throw new Error('invalid_response');
			if (typeof value.uuid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.uuid)) throw new Error('invalid_response');
			if (value.state !== 'active' && value.state !== 'pending') throw new Error('invalid_response');
			if (typeof value.enabled !== 'boolean') throw new Error('invalid_response');
			if (typeof value.tokenPreview !== 'string' || !/^••••[A-Za-z0-9_-]{4}$/.test(value.tokenPreview)) throw new Error('invalid_response');
			const expiresAtValid = isValidCustomerTimestamp(value.expiresAt);
			const createdAtValid = isValidCustomerTimestamp(value.createdAt);
			const updatedAtValid = isValidCustomerTimestamp(value.updatedAt) && (!createdAtValid || value.updatedAt >= value.createdAt);
			const expired = typeof value.expired === 'boolean' ? value.expired : expiresAtValid ? Date.now() >= value.expiresAt : true;
			return { ...value, expired, timeInvalid: !expiresAtValid || !createdAtValid || !updatedAtValid };
		}
		function validateListPayload(value) {
			if (!hasExactFields(value, ['items','cursor','migrationRequired']) || !Array.isArray(value.items)) throw new Error('invalid_response');
			if (value.cursor !== null && typeof value.cursor !== 'string') throw new Error('invalid_response');
			if (!Number.isSafeInteger(value.migrationRequired) || value.migrationRequired < 0) throw new Error('invalid_response');
			return { items: value.items.map(validateCustomer), cursor: value.cursor, migrationRequired: value.migrationRequired };
		}
		function clearMessage() { elements.message.hidden = true; elements.message.textContent = ''; elements.message.className = 'message'; }
		function showMessage(text, type) { elements.message.textContent = text; elements.message.className = 'message ' + (type === 'info' ? 'info' : 'error'); elements.message.hidden = false; }
		function statusOf(customer) {
			if (customer.timeInvalid) return 'pending';
			if (customer.state !== 'active') return 'pending';
			if (customer.enabled === false) return 'disabled';
			if (customer.expired === true) return 'expired';
			return 'normal';
		}
		function statusLabel(status) { return { normal:'正常', disabled:'已停用', expired:'已过期', pending:'待处理' }[status] || '待处理'; }
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
			if (customer.timeInvalid || status === 'disabled' && customer.expired) {
				const note = document.createElement('span');
				note.className = 'status-note';
				note.textContent = customer.timeInvalid ? '时间异常' : '同时已过期';
				cell.appendChild(note);
			}
			return cell;
		}
		function renderStats() {
			const counts = { normal:0, disabled:0, expired:0, pending:0 };
			customerOrder.forEach((customerId) => { const customer = customersById.get(customerId); if (customer) counts[statusOf(customer)] += 1; });
			elements.counts.loaded.textContent = String(customersById.size);
			elements.counts.normal.textContent = String(counts.normal);
			elements.counts.disabled.textContent = String(counts.disabled);
			elements.counts.expired.textContent = String(counts.expired);
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
				cell.colSpan = 10;
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
				row.appendChild(createTextCell('创建时间', formatLocalTime(customer.createdAt)));
				row.appendChild(createTextCell('Token', customer.tokenPreview));
				row.appendChild(createTextCell('操作', '操作功能下一步开放', 'muted'));
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
			elements.refresh.disabled = listBusy;
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
				clearCustomerState();
				window.location.href = '/login';
				throw new Error('redirecting');
			}
			const contentType = response.headers.get('Content-Type') || '';
			if (!contentType.toLowerCase().includes('application/json')) throw new Error(errorMessageForStatus(response.status));
			let payload;
			try { payload = await response.json(); } catch (_) { throw new Error(errorMessageForStatus(response.status)); }
			if (!response.ok) throw new Error(errorMessageForStatus(response.status));
			try { return validateListPayload(payload); } catch (_) { throw new Error('服务返回的数据格式异常，请稍后重试'); }
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
			clearMessage();
			clearCustomerState();
			void loadPage(null, requestGeneration);
		}
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
