// 最终生成浏览器脚本回归测试。
//
// 背景：admin-members.js 的内联管理脚本位于 renderAdminMembersPage() 的 HTML 模板字符串内，
// 模板求值会处理反斜杠转义。曾出现两类被模板破坏的 bug：
//   1. formatTrafficBytes 的 /\.0+$/ 被改写为 /.0+$/（数字丢失，只显示 GiB）；
//   2. deleteCustomer 的 window.prompt 文案中 \n 被转成真实换行，导致整段脚本未终止字符串、
//      管理后台完全不可用（列表为空、按钮失效）。
// 因此必须对“最终渲染出的完整 <script>”做整体语法检查，而不是只检查单个函数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const adminModule = await import('../admin-members.js');
const GIB = 1024 ** 3;

let renderedPromise = null;
function getRenderedScript() {
	if (!renderedPromise) {
		renderedPromise = (async () => {
			const response = adminModule.renderAdminMembersPage();
			const html = await response.text();
			const scriptMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
			assert.ok(scriptMatch, 'inline admin script not found');
			return scriptMatch[1];
		})();
	}
	return renderedPromise;
}

test('最终生成的管理脚本整段通过语法解析（vm.Script）', async () => {
	const script = await getRenderedScript();
	assert.doesNotThrow(() => new vm.Script(script), 'rendered inline script must parse without syntax errors');
});

test('deleteCustomer 的 window.prompt 文案保留 \\n 转义，而非引号内真实换行', async () => {
	const script = await getRenderedScript();
	assert.ok(
		/window\.prompt\('永久删除警告：\\n订阅将立即失效；\\n客户记录与流量记录将被永久删除；\\n此操作不可恢复。\\n请输入客户名称以确认：'/.test(script),
		'prompt must keep backslash-n escapes',
	);
	assert.ok(
		!/window\.prompt\('永久删除警告：\n订阅将立即失效/.test(script),
		'prompt must not contain a real newline inside the string literal',
	);
});

test('流量数字显示修复仍在（渲染脚本正则 \\\\.0+$ 保留）', async () => {
	const script = await getRenderedScript();
	assert.ok(/replace\(\/\\\.0\+\$\//.test(script), 'rendered script must keep the escaped-dot regex');
	assert.ok(!/replace\(\/\.0\+\$\//.test(script), 'rendered script must not contain the unescaped-dot regex');
});

test('管理脚本关键事件绑定存在（创建表单、快捷套餐、套餐按钮）', async () => {
	const script = await getRenderedScript();
	assert.ok(script.includes("elements.createForm.addEventListener('submit'"), 'create form submit binding must exist');
	assert.ok(script.includes("elements.quickDays.forEach"), 'quick-day buttons binding must exist');
	assert.ok(script.includes("elements.packageSetQuota.addEventListener"), 'package set-quota binding must exist');
});

test('渲染脚本的 formatTrafficBytes 输出 200/100/0 GiB 完整数字', async () => {
	const script = await getRenderedScript();
	const dayMatch = script.match(/const DAY_MS[^;]*;/);
	const fmtMatch = script.match(/function formatTrafficBytes\(value\) \{[\s\S]*?\n\t\t\}/);
	assert.ok(dayMatch && fmtMatch, 'constants and formatter not found');
	const sandbox = vm.createContext({ Number, JSON });
	vm.runInContext(dayMatch[0] + '\n' + fmtMatch[0] + '\nglobalThis.__fmt = formatTrafficBytes;', sandbox);
	const fmt = (value) => vm.runInContext('__fmt(' + JSON.stringify(value) + ')', sandbox);
	assert.equal(fmt(200 * GIB), '200 GiB');
	assert.equal(fmt(100 * GIB), '100 GiB');
	assert.equal(fmt(0), '0 GiB');
});
