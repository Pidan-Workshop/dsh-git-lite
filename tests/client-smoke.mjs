/**
 * 浏览器半区冒烟测试：在 Node 里用 vm 模拟 window.__ModuleLoader__ 与 React，
 * 验证模块形状与三个注册点确实被调用。不需要浏览器，也不需要 DSH 运行时。
 *   node tests/client-smoke.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

let passed = 0
function check(label, fn) {
	fn()
	passed += 1
	console.log(`  ✓ ${label}`)
}

console.log('dsh-git-lite client smoke')

// ── 在受控沙箱里执行 lib/client.js ─────────────────────────────
const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let definition = null
const sandbox = {
	window: {
		__ModuleLoader__: {
			load: (def) => {
				definition = def
			}
		}
	},
	navigator: { language: 'zh-CN' },
	console: { log: () => {}, warn: () => {}, error: () => {} },
	setInterval: () => 0,
	clearInterval: () => {},
	fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, value: {} }) })
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(src, sandbox)

check('通过 __ModuleLoader__.load 注册，id 与包名一致', () => {
	assert.ok(definition !== null, '__ModuleLoader__.load 未被调用')
	assert.equal(definition.id, 'dsh-git-lite')
	assert.equal(typeof definition.factory, 'function')
})

// ── React 桩：apply 阶段只注册，不渲染 ─────────────────────────
function reactStub() {
	return {
		createElement: () => null,
		useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
		useEffect: () => {},
		useMemo: (fn) => fn(),
		useSyncExternalStore: (_sub, get) => get()
	}
}

const required = []
const mod = definition.factory((name) => {
	required.push(name)
	if (name === 'react') return reactStub()
	throw new Error('unexpected require: ' + name)
})

check('只 require("react")，不依赖其它外部模块', () => {
	assert.deepEqual(required, ['react'])
})

check('导出 apply / inject 契约', () => {
	assert.equal(typeof mod.apply, 'function')
	// vm 沙箱里的数组原型与本 realm 不同，deepStrictEqual 会比较原型，故先归一化。
	assert.deepEqual(Array.from(mod.inject), ['sessions', 'locale'])
	assert.equal(typeof mod.default, 'undefined')
})

// ── 用假 ctx 跑 apply，检查三个注册点 ──────────────────────────
const tabTypes = []
const slotSeats = []
const slotRegistrations = []
const openedTabs = []
const injectedDeps = []

const scope = {
	sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ current: undefined }) } },
	locale: { getLocale: () => ({ active: 'zh' }), subscribe: () => () => {} },
	sidebarRight: {
		openTab: (kind) => openedTabs.push(kind)
	},
	sidebarRightTabs: {
		register: (def) => {
			tabTypes.push(def)
			return () => {}
		}
	},
	slots: {
		inject: (seat, fn) => {
			slotSeats.push(seat)
			return fn()
		},
		register: (opts, component) => {
			slotRegistrations.push({ opts, component })
			return () => {}
		}
	}
}

const ctx = {
	locale: { getLocale: () => ({ active: 'zh' }), subscribe: () => () => {} },
	inject: (deps, cb) => {
		injectedDeps.push(deps)
		return cb(scope)
	}
}

check('apply 不抛异常', () => {
	mod.apply(ctx)
})

check('注册了 tab 类型（id/kind 均为 git-lite，guide 五件套齐全）', () => {
	assert.equal(tabTypes.length, 1)
	const def = tabTypes[0]
	assert.equal(def.id, 'git-lite')
	assert.equal(def.kind, 'git-lite')
	assert.equal(def.priority, 'extension')
	assert.equal(typeof def.title, 'function')
	assert.equal(def.guide.length, 1)
	const g = def.guide[0]
	// 缺 description/icon 会让工作区启动卡与官方卡片对不齐。
	for (const k of ['id', 'order', 'title', 'description', 'icon']) {
		assert.ok(g[k] !== undefined, `guide 缺字段 ${k}`)
	}
})

check('注册了 tab 主体到 sidebar.right.pane.tab（keyed，key = tab type id）', () => {
	const hit = slotRegistrations.filter((r) => r.opts.name === 'sidebar.right.pane.tab')
	assert.equal(hit.length, 1)
	assert.equal(hit[0].opts.key, 'git-lite')
	assert.equal(typeof hit[0].component, 'function')
	assert.equal(typeof hit[0].opts.inject, 'function')
	// inject() 必须提供组件渲染所需的 sessions/locale
	const injected = hit[0].opts.inject()
	assert.ok(injected.sessions !== undefined)
	assert.ok(injected.locale !== undefined)
})

check('注册了 tab 标题到 sidebar.right.pane.tab.title', () => {
	const hit = slotRegistrations.filter((r) => r.opts.name === 'sidebar.right.pane.tab.title')
	assert.equal(hit.length, 1)
	assert.equal(hit[0].opts.key, 'git-lite')
})

check('注册了分支胶囊到 conversation.input.dock', () => {
	const hit = slotRegistrations.filter((r) => r.opts.name === 'conversation.input.dock')
	assert.equal(hit.length, 1)
	assert.equal(hit[0].opts.id, 'git-lite-branch-chip')
	const injected = hit[0].opts.inject()
	assert.equal(typeof injected.openTab, 'function')
	// 胶囊点击应当打开 git-lite 这个 kind
	injected.openTab()
	assert.deepEqual(openedTabs, ['git-lite'])
})

check('两处 ctx.inject 的依赖名都真实存在', () => {
	assert.equal(injectedDeps.length, 2)
	for (const deps of injectedDeps) {
		for (const d of deps) {
			assert.ok(
				['sidebarRightTabs', 'slots', 'sessions', 'locale', 'sidebarRight'].includes(d),
				`未知依赖 ${d}`
			)
		}
	}
})

check('未使用任何不存在的槽位名', () => {
	const known = ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'conversation.input.dock']
	for (const seat of slotSeats) {
		assert.ok(known.includes(seat), `未知槽位 ${seat}`)
	}
})

console.log(`\n${passed} 项通过`)
