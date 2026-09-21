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

// 注意：vm 沙箱里产生的对象/数组，其原型与本 realm 不同，
// assert.deepStrictEqual 会比较原型而失败。凡是比较沙箱返回值，
// 一律先归一化（Array.from / 逐字段断言）。
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

// 记录 ctx.effect 的调用：注册表契约要求调用方把返回的 disposer 挂在 effect 上，
// 丢弃它会让注册活过本代插件，热重载后 apply 再跑就撞「已注册」。
const effects = []
const ctx = {
	locale: { getLocale: () => ({ active: 'zh' }), subscribe: () => () => {} },
	inject: (deps, cb) => {
		injectedDeps.push(deps)
		return cb(scope)
	},
	effect: (fn, label) => {
		effects.push({ label, dispose: fn() })
		return () => {}
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

check('注册了分支胶囊到会话头部右对齐区（而非输入框上方）', () => {
	const hit = slotRegistrations.filter(
		(r) => r.opts.name === 'conversation.session.header.utilities'
	)
	assert.equal(hit.length, 1)
	assert.equal(hit[0].opts.id, 'git-lite-header-branch')
	const injected = hit[0].opts.inject()
	assert.equal(typeof injected.openTab, 'function')
	// 胶囊点击应当打开 git-lite 这个 kind
	injected.openTab()
	assert.deepEqual(openedTabs, ['git-lite'])
})

check('不再往 conversation.input.dock 注册（避免额外占一行）', () => {
	const hit = slotRegistrations.filter((r) => r.opts.name === 'conversation.input.dock')
	assert.equal(hit.length, 0)
})

check('每个注册的 disposer 都被 ctx.effect 持有（HMR 安全的关键）', () => {
	// 回归：曾经丢弃 disposer → 注册活过本代插件 → 热重载后 apply 再跑，
	// tab type 注册抛「already registered」，并连带跳过主体/标题注册，
	// 表现为 Git 标签页显示 tab.unavailable。
	assert.equal(effects.length, 4, '四个注册各应挂一个 effect')
	for (const e of effects) {
		assert.equal(typeof e.dispose, 'function', e.label + ' 的 disposer 未被持有')
	}
	assert.deepEqual(
		effects.map((e) => e.label),
		[
			'dsh-git-lite: tab type',
			'dsh-git-lite: pane body',
			'dsh-git-lite: pane title',
			'dsh-git-lite: header chip'
		]
	)
})

check('注册失败被兜住且不抛给调用方（一个失败不连累其余）', () => {
	// 让 tab type 注册抛错，其余三个仍应注册成功。
	const regs = []
	const sc = {
		sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ current: undefined }) } },
		locale: { getLocale: () => ({ active: 'zh' }), subscribe: () => () => {} },
		sidebarRight: { openTab: () => {} },
		sidebarRightTabs: {
			register: () => {
				throw new Error('already registered')
			}
		},
		slots: {
			inject: (seat, fn) => fn(),
			register: (o) => {
				regs.push(o.name)
				return () => {}
			}
		}
	}
	const localEffects = []
	assert.doesNotThrow(() => {
		mod.apply({
			locale: { getLocale: () => ({ active: 'zh' }), subscribe: () => () => {} },
			inject: (_d, cb) => cb(sc),
			effect: (fn, label) => {
				localEffects.push({ label, dispose: fn() })
				return () => {}
			}
		})
	})
	assert.equal(localEffects.length, 4)
	// tab type 的 disposer 应为 undefined（抛错被兜住），其余三个仍是函数
	assert.equal(localEffects[0].dispose, undefined)
	for (const e of localEffects.slice(1)) {
		assert.equal(typeof e.dispose, 'function', e.label + ' 应仍然注册成功')
	}
	assert.deepEqual(regs, ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'conversation.session.header.utilities'])
})

check('三处 ctx.inject 的依赖名都真实存在，且各自只声明所需服务', () => {
	// 拆成三块是刻意的：注册互不连累，且每块依赖最小化（越早订阅 seat 声明越好）。
	assert.equal(injectedDeps.length, 3)
	const seen = []
	for (const deps of injectedDeps) {
		seen.push(deps.join(','))
		for (const d of deps) {
			assert.ok(
				['sidebarRightTabs', 'slots', 'sessions', 'locale', 'sidebarRight'].includes(d),
				`未知依赖 ${d}`
			)
		}
	}
	assert.deepEqual(seen, ['sidebarRightTabs', 'slots,sessions,locale', 'slots,sessions,locale,sidebarRight'])
})

check('未使用任何不存在的槽位名', () => {
	const known = [
		'sidebar.right.pane.tab',
		'sidebar.right.pane.tab.title',
		'conversation.session.header.utilities'
	]
	for (const seat of slotSeats) {
		assert.ok(known.includes(seat), `未知槽位 ${seat}`)
	}
})

// ── 避开第三方固定浮层的几何判断 ───────────────────────────────
const { computeOverlayInset } = mod.__internals

/** 一个操练基准：视口高 900，提交区底边 900，按钮横跨 16–290，上限 240。 */
function geo(overlays) {
	return computeOverlayInset({
		panelBottom: 900,
		rowLeft: 16,
		rowRight: 290,
		viewportHeight: 900,
		maxInset: 240,
		overlays
	})
}

check('没有浮层时不让位', () => {
	assert.equal(geo([]), 0)
})

check('浮层在按钮右侧（全屏场景）不让位 —— 这是"智能"的关键', () => {
	// godot-play 的悬浮按钮：right:14px，宽约 120 → 左边界 766。按钮止于 290。
	assert.equal(geo([{ top: 830, left: 766, right: 886, height: 44 }]), 0)
})

check('浮层压住按钮且横向相交时，按重叠高度让位', () => {
	// 浮层顶边 850，提交区底边 900 → 需要 50px。
	assert.equal(geo([{ top: 850, left: 200, right: 320, height: 44 }]), 50)
})

check('取多个浮层中最大的重叠高度', () => {
	assert.equal(
		geo([
			{ top: 870, left: 100, right: 200, height: 30 },
			{ top: 840, left: 250, right: 300, height: 44 }
		]),
		60
	)
})

check('浮层顶边在提交区底边之下（未压到）不让位', () => {
	assert.equal(geo([{ top: 900, left: 100, right: 200, height: 44 }]), 0)
})

check('整块面板不参与避让（高度 > 视口 40%）', () => {
	// 高度 400 > 900*0.4，即便相交也跳过。
	assert.equal(geo([{ top: 500, left: 100, right: 600, height: 400 }]), 0)
})

check('内缩量被 maxInset 钳制', () => {
	// 重叠 880，但上限 240。
	assert.equal(geo([{ top: 20, left: 100, right: 200, height: 100 }]), 240)
})

check('横向刚好相切（不重叠）不让位', () => {
	// 浮层左边界正好等于按钮右边界 → 重叠为 0。
	assert.equal(geo([{ top: 850, left: 290, right: 400, height: 44 }]), 0)
})

// ── 胶囊的轮询节奏 ─────────────────────────────────────────────
// 回归：切会话时第一次请求常常赶在会话就绪之前（宿主返回 session-unknown），
// 若下一次要等一整个 6 秒轮询周期，用户就会看到「过一会才刷出来」。
const { chipRetryDelay } = mod.__internals

check('失败后立刻快重试，不再干等一个轮询周期', () => {
	assert.equal(chipRetryDelay(1), 500, '第一次失败应 500ms 后重试')
	assert.equal(chipRetryDelay(2), 500)
	assert.ok(chipRetryDelay(1) < 6000, '必须远小于常规轮询间隔')
})

check('连续失败超过上限后退回常规节奏（不做无限快轮询）', () => {
	assert.equal(chipRetryDelay(12), 500, '上限内仍快重试')
	assert.equal(chipRetryDelay(13), 6000, '超限后回常规节奏')
	assert.equal(chipRetryDelay(999), 6000)
})

check('成功（failures=0）后回到常规轮询间隔', () => {
	assert.equal(chipRetryDelay(0), 6000)
})

// ── 列表 / diff 分隔条的 clamp ─────────────────────────────────
// clamp 边界写错会让某一侧塌成 0 高度，看起来像"内容不见了"。
const { clampListHeight } = mod.__internals
const BODY = 600
const LIST_MIN = 56
const DIFF_MIN = 90

check('正常区间内按指针位置分配', () => {
	assert.equal(clampListHeight(300, BODY, LIST_MIN, DIFF_MIN), 300)
})

check('低于列表最小值时钳到最小值', () => {
	assert.equal(clampListHeight(10, BODY, LIST_MIN, DIFF_MIN), LIST_MIN)
	assert.equal(clampListHeight(0, BODY, LIST_MIN, DIFF_MIN), LIST_MIN)
	assert.equal(clampListHeight(-40, BODY, LIST_MIN, DIFF_MIN), LIST_MIN)
})

check('高于上限时钳到「容器高 − diff 最小值」', () => {
	// 600 - 90 = 510，保证 diff 至少有 90px
	assert.equal(clampListHeight(9999, BODY, LIST_MIN, DIFF_MIN), BODY - DIFF_MIN)
	assert.equal(clampListHeight(511, BODY, LIST_MIN, DIFF_MIN), BODY - DIFF_MIN)
})

check('恰好落在边界上不抖动', () => {
	assert.equal(clampListHeight(LIST_MIN, BODY, LIST_MIN, DIFF_MIN), LIST_MIN)
	assert.equal(clampListHeight(BODY - DIFF_MIN, BODY, LIST_MIN, DIFF_MIN), BODY - DIFF_MIN)
})

check('容器矮到放不下两个最小值时，优先保住 diff 且不返回负数', () => {
	// 100 < 56 + 90：max = 10 < listMin → 返回 10（列表让位，diff 保 90）
	assert.equal(clampListHeight(500, 100, LIST_MIN, DIFF_MIN), 10)
	// 极端：容器比 diff 最小值还矮 → 返回 0 而不是负数
	assert.equal(clampListHeight(500, 40, LIST_MIN, DIFF_MIN), 0)
})

check('结果是整数（避免逐帧小数导致布局抖动）', () => {
	assert.equal(clampListHeight(300.7, BODY, LIST_MIN, DIFF_MIN), 301)
	assert.ok(Number.isInteger(clampListHeight(300.4, 601, LIST_MIN, DIFF_MIN)))
})



// ── 胶囊的四种状态 ─────────────────────────────────────────────
const { chipState } = mod.__internals
const briefOf = (branch) => ({ branch: branch, files: [], ahead: 0, behind: 0 })

check('有分支 → ready', () => {
	assert.equal(chipState(briefOf('main'), null, 's1'), 'ready')
	assert.equal(chipState(briefOf('explore/draft'), null, 's1'), 'ready')
})

check('尚无答复且会话已选定 → loading（不留空白）', () => {
	assert.equal(chipState(null, null, 's1'), 'loading')
})

check('宿主权威错误 → norepo（弱化胶囊，原因在 tooltip）', () => {
	assert.equal(chipState(null, 'this workspace is not inside a git repository', 's1'), 'norepo')
})

check('连会话都没有 → idle（不占位，而不是一直转圈）', () => {
	assert.equal(chipState(null, null, undefined), 'idle')
})

check('status 成功但拿不到 branch → 不当作 ready', () => {
	// 例如游离头等边界：必须落到 loading 而不是渲染一个空分支名。
	assert.equal(chipState({ files: [] }, null, 's1'), 'loading')
})

check('权威错误优先于 loading（错误的 branch 字段不该掩盖错误）', () => {
	assert.equal(chipState({ files: [] }, 'not a repo', 's1'), 'norepo')
})

// ── 失败时「清空」还是「保留上次值」 ───────────────────────────
// 这是 loading 只出现在首次加载的关键：瞬态失败必须保留 brief，
// 否则每次轮询抖动都会把胶囊打回加载态来回闪。
const { onStatusFailure } = mod.__internals

check('权威错误 → 清掉旧值并给出原因', () => {
	for (const code of ['not-a-repo', 'no-workspace', 'workspace-unknown', 'outside-workspace']) {
		const v = onStatusFailure({ code, message: 'boom-' + code })
		assert.equal(v.clearBrief, true, code + ' 应清空')
		assert.equal(v.errorText, 'boom-' + code)
	}
})

check('session-unknown → 保留上次值（尚未就绪，不是没有仓库）', () => {
	const v = onStatusFailure({ code: 'session-unknown', message: 'no live session with that id' })
	assert.equal(v.clearBrief, false)
	assert.equal(v.errorText, null)
})

check('无 code 的网络抖动 → 保留上次值', () => {
	// 注意：vm 沙箱返回的对象原型与本 realm 不同，deepStrictEqual 会比较原型，
	// 所以这里逐字段断言而不是整体比较。
	for (const err of [new Error('Failed to fetch'), undefined]) {
		const v = onStatusFailure(err)
		assert.equal(v.clearBrief, false)
		assert.equal(v.errorText, null)
	}
})

check('保留上次值 + 已有 brief 时，状态仍是 ready（不闪回 loading）', () => {
	// 模拟：先成功，再遇到一次瞬态失败 —— brief 保留，briefErr 未被设置。
	const brief = briefOf('main')
	const v = onStatusFailure({ code: 'session-unknown' })
	const kept = v.clearBrief ? null : brief
	assert.equal(chipState(kept, v.errorText, 's1'), 'ready')
})

// ── 提交时间格式化 ─────────────────────────────────────────────
const { formatCommitTime } = mod.__internals

check('非法时间返回空串而不是 NaN', () => {
	assert.equal(formatCommitTime(''), '')
	assert.equal(formatCommitTime('not-a-date'), '')
	assert.equal(formatCommitTime(undefined), '')
})

check('合法 ISO 产出 MM-DD HH:mm 形状', () => {
	// 不断言具体小时：结果依赖运行机器的时区。
	assert.match(formatCommitTime('2026-09-20T10:00:00+08:00'), /^\d{2}-\d{2} \d{2}:\d{2}$/)
	assert.match(formatCommitTime('2026-01-02T03:04:05Z'), /^\d{2}-\d{2} \d{2}:\d{2}$/)
})

check('月/日/时/分都补零', () => {
	const s = formatCommitTime('2026-01-02T03:04:05Z')
	assert.equal(s.length, 11)
	assert.ok(s.includes('-'), '应有日期分隔符')
})


// ── 按日期分组提交 ─────────────────────────────────────────────
const { localDayKey, formatDayLabel, groupCommitsByDay } = mod.__internals

check('localDayKey 用本地日；非法输入返回空串', () => {
	// 取 UTC 正午：在任何现实时区下本地日期都是同一天，断言因此与时区无关
	assert.equal(localDayKey('2026-09-12T12:00:00Z'), '2026-09-12')
	assert.equal(localDayKey(''), '')
	assert.equal(localDayKey('nope'), '')
})

check('groupCommitsByDay 只合并相邻同日', () => {
	const g = groupCommitsByDay([
		{ date: '2026-09-12T12:00:00Z', subject: 'a' },
		{ date: '2026-09-12T06:00:00Z', subject: 'b' },
		{ date: '2026-09-11T12:00:00Z', subject: 'c' }
	])
	assert.equal(g.length, 2)
	assert.equal(g[0].day, '2026-09-12')
	assert.deepEqual(Array.from(g[0].commits, (c) => c.subject), ['a', 'b'])
	assert.equal(g[1].day, '2026-09-11')
	assert.equal(g[1].commits.length, 1)
})

check('同一天不连续时产生两个分组（不全局归并）', () => {
	// 全局归并会打乱时间顺序，也会让分页追加时同一天出现两组
	const g = groupCommitsByDay([
		{ date: '2026-09-12T12:00:00Z' },
		{ date: '2026-09-11T12:00:00Z' },
		{ date: '2026-09-12T06:00:00Z' }
	])
	assert.equal(g.length, 3)
})

check('空列表与全非法日期', () => {
	assert.equal(Array.from(groupCommitsByDay([])).length, 0)
	const g = groupCommitsByDay([{ date: '' }, { date: 'bad' }])
	assert.equal(g.length, 1, '两个非法日期应归入同一组')
	assert.equal(g[0].day, '')
})

check('formatDayLabel 本地化且非法输入不抛', () => {
	assert.match(formatDayLabel('2026-09-12T12:00:00Z', 'zh'), /2026/)
	assert.match(formatDayLabel('2026-09-12T12:00:00Z', 'en'), /2026/)
	assert.equal(formatDayLabel('bad', 'zh'), '')
	// 未知语言不该抛，应回退到日期键
	assert.equal(formatDayLabel('2026-09-12T12:00:00Z', 'not a locale'), '2026-09-12')
})


// ── 渲染层检查 ─────────────────────────────────────────────────
// 教训：Btn 曾把 props.t（i18n 字典）当成 theme 用，`t.fg` / `t.accent` / `t.border`
// 全是 undefined —— 主按钮成了「白字无底色」、普通按钮的 `1px solid undefined`
// 是非法 CSS、整条声明被丢弃后回退成浏览器默认边框。这是纯 UI 症状，
// 逻辑测试全绿也照样漏掉，所以补一层渲染检查。

/** 用会递归调用子组件的 h() 把面板渲成一棵树（可 patch 源码以切换状态）。 */
function renderPanel(patch) {
	const source = patch === undefined ? src : patch(src)
	let loaded = null
	const captured = {}
	const box = {
		window: { __ModuleLoader__: { load: (d) => { loaded = d } }, localStorage: null },
		navigator: { language: 'zh-CN' },
		console: { log: () => {}, warn: () => {}, error: () => {} },
		setInterval: () => 0,
		clearInterval: () => {},
		setTimeout: () => 0,
		clearTimeout: () => {},
		fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, value: { branch: 'main', files: [] } }) })
	}
	box.globalThis = box
	vm.createContext(box)
	vm.runInContext(source, box)
	function h(type, props) {
		const kids = [].slice.call(arguments, 2)
		if (typeof type === 'function') return type(Object.assign({}, props, { children: kids }))
		return { type: type, props: props || {}, children: kids }
	}
	const react = {
		createElement: h,
		useState: (i) => [typeof i === 'function' ? i() : i, () => {}],
		useEffect: () => {},
		useMemo: (f) => f(),
		useRef: (i) => ({ current: i }),
		useSyncExternalStore: (_s, g) => g()
	}
	const sc = {
		sessions: {
			list: { subscribe: () => () => {}, getSnapshot: () => ({ current: 's1', byId: { s1: { cwd: '/tmp' } } }) }
		},
		locale: { getLocale: () => ({ active: 'zh' }), subscribe: () => () => {} },
		sidebarRight: { openTab: () => {} },
		sidebarRightTabs: { register: () => () => {} },
		slots: {
			inject: (_s, f) => f(),
			register: (o, c) => {
				captured[o.name] = c
				return () => {}
			}
		}
	}
	const m = loaded.factory((name) => {
		if (name === 'react') return react
		throw new Error(name)
	})
	m.apply({
		locale: { getLocale: () => ({ active: 'zh' }), subscribe: () => () => {} },
		inject: (_d, cb) => cb(sc),
		effect: (f) => {
			f()
		}
	})
	return captured['sidebar.right.pane.tab']({ sessions: sc.sessions, locale: sc.locale })
}

/** 收集树里所有元素节点与文本（数组作为单个子节点时要展开）。 */
function collect(node) {
	const nodes = []
	const texts = []
	;(function walk(n) {
		if (typeof n === 'string') {
			texts.push(n)
			return
		}
		if (Array.isArray(n)) {
			n.forEach(walk)
			return
		}
		if (!n || typeof n !== 'object') return
		nodes.push(n)
		;(n.children || []).forEach(walk)
	})(node)
	return { nodes: nodes, texts: texts }
}

check('渲染出的样式里没有 undefined（曾把字典当主题用）', () => {
	// 这条测试若早点存在，Btn 那个「白字无底色」的 bug 会在提交前就被拦住
	const { nodes } = collect(renderPanel())
	const bad = []
	for (const n of nodes) {
		const style = n.props && n.props.style
		if (!style) continue
		for (const k of Object.keys(style)) {
			const v = style[k]
			if (v === undefined || (typeof v === 'string' && v.indexOf('undefined') !== -1)) {
				bad.push(k + '=' + String(v))
			}
		}
	}
	assert.equal(bad.length, 0, '出现 undefined 样式：' + bad.slice(0, 5).join(', '))
})

check('主按钮用主题强调色，普通按钮用主题边框色', () => {
	// 沙箱里没有 matchMedia，useDark() 返回 false → 浅色主题
	const LIGHT_ACCENT = '#0969da'
	const LIGHT_BORDER = '#d0d7de'
	const { nodes } = collect(renderPanel())
	const buttons = nodes.filter((n) => n.type === 'button')
	// 注意：树里靠前的 button 是分段控件的「变更/历史」，所以必须按文案找，
	// 不能按下标猜。子串匹配用于带 emoji 的文案（'✨ 生成信息'）。
	const find = (label) =>
		buttons.find((b) => collect(b).texts.join('').indexOf(label) !== -1)
	const findExact = (label) => buttons.find((b) => collect(b).texts.join('') === label)

	const commit = findExact('提交')
	assert.ok(commit, '找不到「提交」按钮')
	assert.equal(commit.props.style.color, '#fff')
	assert.equal(commit.props.style.background, LIGHT_ACCENT)

	const normal = find('生成信息')
	assert.ok(normal, '找不到「生成信息」按钮')
	assert.ok(
		normal.props.style.border.indexOf(LIGHT_BORDER) !== -1,
		'普通按钮边框应为主题边框色，实际：' + normal.props.style.border
	)
})

/** 渲染历史模式（带一条提交），供下面几条结构用例复用。 */
const LOG_FIXTURE =
	"{commits:[{sha:'a1',short:'a1',subject:'x',author:'me',date:'2026-09-12T12:00:00Z',refs:[]}],hasMore:false}"
function renderHistory() {
	return renderPanel((s) =>
		s
			.replace("React.useState('changes')", "React.useState('log')")
			.replace('var [logState, setLogState] = React.useState(null)', 'var [logState, setLogState] = React.useState(' + LOG_FIXTURE + ')')
	)
}

check('日期分组标题不加下边框（否则会横穿导轨）', () => {
	// 标题行若带整宽下边框，会在每个分组边界与导轨形成"十"字交叉，看起来像梯子
	const { nodes } = collect(renderHistory())
	const header = nodes.find((n) => {
		const st = n.props && n.props.style
		return st && st.position === 'sticky' && collect(n).texts.join('').indexOf('的提交') !== -1
	})
	assert.ok(header, '找不到分组标题行')
	assert.equal(header.props.style.borderBottom, undefined, '标题行不应有下边框')
	assert.equal(header.props.style.background, '#ffffff', 'sticky 需要不透明背景，否则滚动时下文透出来')
})

check('提交行是内缩圆角卡片，而不是通栏分隔线', () => {
	// 通栏分隔线会紧贴导轨起笔，与导轨一起把左侧糊成网格
	const { nodes } = collect(renderHistory())
	const card = nodes.find((n) => n.props && n.props['data-git-lite-commit'] === '')
	assert.ok(card, '找不到提交卡片')
	assert.equal(card.props.style.borderBottom, undefined, '卡片不应有通栏下边框')
	assert.equal(card.props.style.borderRadius, 6)
	assert.equal(card.props.style.border, '1px solid #d0d7de')
	assert.ok(card.props.style.margin !== undefined, '卡片需要外边距与相邻卡片分开')
})

check('日期分组的标题与提交文字用同一个 gutter（导轨对齐）', () => {
	// 曾经标题额外加了 8px 内边距去避开越界的连接线，导致标题比提交文字右移 8px
	const { nodes } = collect(renderHistory())
	// 两处 gutter 的宽度必须一致，且连接线不得越出 gutter（即 width + marginLeft ≤ gutter/2）
	const gutters = nodes.filter((n) => n.props && n.props.style && String(n.props.style.flex || '').indexOf('0 0 ') === 0 && n.props.style.position === 'relative')
	assert.ok(gutters.length >= 2, '应至少有两个 gutter（标题行 + 提交列），实际 ' + gutters.length)
	const widths = new Set(gutters.map((g) => g.props.style.flex))
	assert.equal(widths.size, 1, 'gutter 宽度不一致：' + [...widths].join(' / '))
	const gutterPx = Number([...widths][0].split(' ')[2].replace('px', ''))
	let leftArms = 0
	let rightArms = 0
	for (const g of gutters) {
		for (const child of g.children) {
			const st = child && child.props && child.props.style
			if (!st || typeof st.width !== 'number') continue
			// 横向臂：由 marginLeft 或 marginRight 抵消定位，两端都不得越出 gutter 中线
			const offset = st.marginLeft !== undefined ? st.marginLeft : st.marginRight
			if (offset === undefined) continue
			assert.ok(
				offset + st.width <= gutterPx / 2 + 0.001,
				'gutter 内的线段越界：offset=' + offset + ' width=' + st.width
			)
			// 只把「1px 高的水平臂」计入左右对称检查：
			// 导轨（width 1）与节点（height 9）也有 marginLeft，不该被算成右臂
			if (st.height === 1) {
				if (st.marginLeft !== undefined) rightArms += 1
				if (st.marginRight !== undefined) leftArms += 1
			}
		}
	}
	// 节点应为「—◯—」：左右各一条对称横线（只画右边会不像 GitHub）
	assert.equal(rightArms, leftArms, '节点左右横线数量应相等：left=' + leftArms + ' right=' + rightArms)
	assert.ok(leftArms >= 1, '节点缺少左侧横线')

	// 竖线与节点互斥：节点那一行不得再画竖线，否则节点上下会露出两小段残根
	const isNode = (g) => g.children.some((c) => c && c.props && c.props.style && c.props.style.borderRadius === '50%')
	const hasRail = (g) => g.children.some((c) => c && c.props && c.props.style && c.props.style.width === 1)
	const nodeRows = gutters.filter(isNode)
	const plainRows = gutters.filter((g) => !isNode(g))
	assert.ok(nodeRows.length >= 1, '应有带节点的 gutter')
	assert.ok(plainRows.length >= 1, '应有只画竖线的 gutter')
	for (const g of nodeRows) {
		assert.equal(hasRail(g), false, '节点行不应再画竖线（会露出上下残根）')
	}
	for (const g of plainRows) {
		assert.equal(hasRail(g), true, '非节点行应画竖线')
	}
})

console.log(`\n${passed} 项通过`)
