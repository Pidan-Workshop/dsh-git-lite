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

// 定时器：client.js 只用 setTimeout 做「注册冲突重试」与延迟关提示。
// 这里不真跑回调，而是记下来由用例显式 flush —— 重试路径因此可确定性测试。
const timers = []
let timerSeq = 0
function flushTimers() {
	let ran = 0
	for (;;) {
		const next = timers.find((t) => t.alive)
		if (next === undefined) return ran
		next.alive = false
		next.fn()
		ran += 1
		if (ran > 100) throw new Error('定时器没有收敛（疑似死循环）')
	}
}

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
	setTimeout: (fn, ms) => {
		timerSeq += 1
		timers.push({ id: timerSeq, fn, ms, alive: true })
		return timerSeq
	},
	clearTimeout: (id) => {
		for (const t of timers) if (t.id === id) t.alive = false
	},
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
	// 抛一个**非冲突**错误：重试治不了这类问题，应立即兜住并继续后面的注册。
	// 冲突错误的处理见下方「注册冲突会重试」用例。
	const regs = []
	const sc = {
		sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ current: undefined }) } },
		locale: { getLocale: () => ({ active: 'zh' }), subscribe: () => () => {} },
		sidebarRight: { openTab: () => {} },
		sidebarRightTabs: {
			register: () => {
				throw new Error('slot wiring mistake')
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
	// 每个 effect 都返回自己的清理函数：注册可能因重试而**延迟到达**，
	// 清理函数负责在卸载时释放它（不再是「抛错就没有 disposer」）。
	for (const e of localEffects) {
		assert.equal(typeof e.dispose, 'function', e.label + ' 应返回清理函数')
	}
	assert.deepEqual(regs, ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'conversation.session.header.utilities'])
})

check('「already registered」被判为可重试的注册冲突', () => {
	const { isRegistrationConflict } = mod.__internals
	assert.equal(
		isRegistrationConflict(new Error('sidebarRight: tab type id "git-lite" is already registered')),
		true
	)
	assert.equal(
		isRegistrationConflict(new Error('sidebarRight: tab kind "git-lite" is already registered (extension)')),
		true
	)
})

check('其它注册错误不重试（避免空等一秒），非法输入也不炸', () => {
	const { isRegistrationConflict } = mod.__internals
	assert.equal(isRegistrationConflict(new Error('slot "nope" is not declared')), false)
	assert.equal(isRegistrationConflict(new Error('boom')), false)
	assert.equal(isRegistrationConflict(undefined), false)
	assert.equal(isRegistrationConflict(null), false)
	assert.equal(isRegistrationConflict(''), false)
})

check('HMR 下注册冲突会重试：旧代释放后补上注册，而不是永久丢掉注册点', () => {
	// 回归：新代 apply() 早于旧代 dispose 时 register 抛 already registered；
	// 旧代码只打一条 warn 就放弃 → 该注册点永久缺失（表现为 tab.unavailable）。
	timers.length = 0
	let attempts = 0
	const registered = []
	const localEffects = []
	const sc = {
		sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ current: undefined }) } },
		locale: { getLocale: () => ({ active: 'zh' }), subscribe: () => () => {} },
		sidebarRight: { openTab: () => {} },
		sidebarRightTabs: {
			register: (def) => {
				attempts += 1
				if (attempts === 1) {
					throw new Error('sidebarRight: tab type id "git-lite" is already registered')
				}
				registered.push(def.id)
				return () => {}
			}
		},
		slots: { inject: (seat, fn) => fn(), register: () => () => {} }
	}
	mod.apply({
		locale: { getLocale: () => ({ active: 'zh' }), subscribe: () => () => {} },
		inject: (_d, cb) => cb(sc),
		effect: (fn, label) => {
			localEffects.push({ label, dispose: fn() })
			return () => {}
		}
	})
	assert.equal(attempts, 1, '首次注册应失败')
	assert.deepEqual(registered, [], '此时还没有注册上')
	assert.ok(
		timers.some((t) => t.alive),
		'应排入一次重试，而不是就此放弃'
	)
	flushTimers()
	assert.equal(attempts, 2, '重试应再尝试一次')
	assert.deepEqual(registered, ['git-lite'], '旧代释放后应补上注册')
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

check('主题色走 DSH 令牌（而不是自己维护明暗两套色板）', () => {
	// 用令牌的好处：配色与应用一致，且**明暗主题自动跟随**（不需要 useDark）
	const { nodes } = collect(renderPanel())
	const buttons = nodes.filter((n) => n.type === 'button')
	// 注意：树里靠前的 button 是分段控件的「变更/历史」，所以必须按文案找，
	// 不能按下标猜。子串匹配用于带 emoji 的文案（'✨ 生成信息'）。
	const find = (label) =>
		buttons.find((b) => collect(b).texts.join('').indexOf(label) !== -1)
	const findExact = (label) => buttons.find((b) => collect(b).texts.join('') === label)

	const commit = findExact('提交')
	assert.ok(commit, '找不到「提交」按钮')
	// 文字色必须用配对的前景令牌，而不是硬编码 #fff：
	// 白字在深色主题的蓝色填充上只有 2.66:1（DSH 自己的发送按钮就是硬编码 #fff）
	assert.ok(
		String(commit.props.style.color).indexOf('--dsw-alias-label-primary-foreground') !== -1,
		'主按钮文字应取 label-primary-foreground，实际：' + commit.props.style.color
	)
	// 主按钮底色必须取**蓝色填充**令牌并带兜底。
	// 回归：曾经用 --dsw-alias-brand-primary —— 那是品牌「前景」色（浅色近黑、
	// 深色近白），当填充用会在深色主题下变成白底白字（看起来是个空白方块）。
	assert.ok(
		commit.props.style.background.indexOf('--dsw-alias-button-info-fill') !== -1,
		'主按钮底色应取 button-info-fill，实际：' + commit.props.style.background
	)
	assert.ok(
		commit.props.style.background.indexOf('brand-primary') === -1,
		'不得再使用 brand-primary 作为填充色，实际：' + commit.props.style.background
	)
	assert.ok(
		commit.props.style.background.indexOf('var(') === 0,
		'令牌必须写成 var(令牌, 兜底) 形式，实际：' + commit.props.style.background
	)

	const normal = find('生成信息')
	assert.ok(normal, '找不到「生成信息」按钮')
	assert.ok(
		normal.props.style.border.indexOf('--dsw-alias-border-l2') !== -1,
		'普通按钮边框应取边框令牌，实际：' + normal.props.style.border
	)

	// 令牌缺失时必须有兜底（被裁剪的部署仍要能看）
	assert.match(commit.props.style.background, /var\([^,]+,\s*[^)]+\)/)
})

check('用户自己的提交按钮排最后，且三个动作各带说明', () => {
	// 明确的产品要求：辅助/AI 动作在前，用户自己的提交在最后（主操作靠右）
	const { nodes } = collect(renderPanel())
	const buttons = nodes.filter((n) => n.type === 'button')
	const labels = ['✨ 生成信息', '交给 Agent 提交', '提交']
	const idx = labels.map((l) => buttons.findIndex((b) => collect(b).texts.join('') === l))
	assert.ok(idx.every((i) => i >= 0), '三个按钮都应存在，实际下标：' + idx.join(','))
	assert.deepEqual(idx, [...idx].sort((a, b) => a - b), '顺序应为 生成信息 → 交给 Agent 提交 → 提交')
	assert.equal(idx[2], Math.max(...idx), '「提交」必须在最后')

	// 三个按钮都必须有说明浮层 —— 光看标签分不清两条提交路径的区别
	for (const l of labels) {
		const b = buttons.find((n) => collect(n).texts.join('') === l)
		assert.ok(b.props.title && b.props.title.length > 10, l + ' 缺少说明浮层')
	}
})

/** 渲染变更模式（注入一份 status），供批量按钮与冲突分组的用例复用。 */
function renderChanges(filesJson) {
	return renderPanel((s) =>
		s.replace(
			'var [status, setStatus] = React.useState(null)',
			'var [status, setStatus] = React.useState({branch:"main",files:' + filesJson + '})'
		)
	)
}

// index / worktree 是真实现场一定有的字段（makeFile 总会填），
// 所以夹具也照填 —— 缺了它们状态字母会渲染成 undefined。
const TWO_FILES =
	"[{path:'b.js',staged:false,index:'.',worktree:'M',untracked:false,unmerged:false},{path:'a.js',staged:true,index:'M',worktree:'.',untracked:false,unmerged:false}]"
// 三个分组同时在场：冲突 / 已暂存 / 变更。用来验证冲突**单独成组**且排在最后面之前。
const WITH_CONFLICT =
	"[{path:'both.js',staged:true,index:'U',worktree:'U',untracked:false,unmerged:true},{path:'a.js',staged:true,index:'M',worktree:'.',untracked:false,unmerged:false},{path:'b.js',staged:false,index:'.',worktree:'M',untracked:false,unmerged:false}]"

/** 找组头行：它的文本恰好是 [标签, 右端动作] 两段。 */
function findHeader(panel, label, actionLabel) {
	const { nodes } = collect(panel)
	return nodes.find((n) => {
		const texts = collect(n).texts
		return texts.length === 2 && texts[0] === label && texts[1] === actionLabel
	})
}

check('「变更」组头右端是「全部暂存」，「已暂存」组头右端是「全部取消暂存」', () => {
	const panel = renderChanges(TWO_FILES)
	const changes = findHeader(panel, '变更', '全部暂存')
	assert.ok(changes, '找不到「变更」组头，或它右端没有「全部暂存」')
	const staged = findHeader(panel, '已暂存', '全部取消暂存')
	assert.ok(staged, '找不到「已暂存」组头，或它右端没有「全部取消暂存」')

	// 组头仍然只占原来那一行：标签 flex:1 吃掉剩余宽度，动作靠右。
	// （这也是选「组头」而不是新增工具行的原因 —— 不额外吃竖向空间。）
	const spans = collect(changes).nodes.filter((n) => n.type === 'span')
	assert.equal(spans[0].props.style.flex, '1 1 auto')
	assert.equal(spans[0].props.style.minWidth, 0)
	const btns = collect(changes).nodes.filter((n) => n.type === 'button')
	assert.equal(btns.length, 1)
	assert.equal(btns[0].props.style.border, '1px solid transparent', '小号动作按钮应无边框')
	assert.ok(String(btns[0].props.title).length > 5, '批量动作缺少说明浮层')
	assert.equal(btns[0].props.disabled, false)

	// 状态字母：颜色必须来自 theme（曾经读字典里的 t.dim/t.del/t.add，恒为 undefined）。
	// 这条断言让「字典当主题用」这种错法在渲染层被钉住。
	const letters = collect(panel).nodes.filter((n) => n.type === 'span' && n.props.style.width === 13)
	assert.ok(letters.length >= 2, '应有状态字母节点')
	for (const l of letters) {
		assert.equal(typeof l.props.style.color, 'string', '状态字母颜色不该是 undefined')
		assert.ok(String(l.props.style.color).indexOf('--dsw-') !== -1, '颜色应走设计令牌')
	}
})

check('冲突单独成一组：组头在最前、冲突文件挂在它下面、两条批量按钮禁用、并给出「Agent 解决冲突」', () => {
	const panel = renderChanges(WITH_CONFLICT)
	const { nodes, texts } = collect(panel)
	const header = findHeader(panel, '1 个文件处于冲突状态', 'Agent 解决冲突')
	assert.ok(header, '找不到冲突分组，或它组头右端没有「Agent 解决冲突」')

	const buttons = nodes.filter((n) => n.type === 'button')
	const resolve = buttons.find((b) => collect(b).texts.join('') === 'Agent 解决冲突')
	assert.ok(resolve, '有冲突时必须给出「Agent 解决冲突」这条出路')
	assert.ok(String(resolve.props.title).length > 10, '「Agent 解决冲突」缺少说明浮层')

	// 分组顺序与归属：列表是「组头 + 若干行」的扁平数组，所以按文本出现次序断言归属。
	// 注意顶部的「变更 / 历史」分段控件里也有「变更」二字，所以找分组标题要**从后往前**找，
	// 否则会命中分段控件、把位置比较全部带偏。
	const at = (s, from) => texts.indexOf(s, from === undefined ? 0 : from)
	assert.ok(at('both.js') !== -1 && at('a.js') !== -1 && at('b.js') !== -1, '三个文件行都应渲染')
	const conflictLabel = at('1 个文件处于冲突状态')
	const stagedLabel = at('已暂存')
	const changesLabel = at('变更', stagedLabel)
	assert.ok(conflictLabel !== -1 && stagedLabel !== -1 && changesLabel !== -1, '三个组头都应渲染')
	assert.ok(conflictLabel < at('both.js'), '冲突文件应排在冲突组头下面')
	assert.ok(at('both.js') < stagedLabel, '冲突组必须排在「已暂存」之前')
	assert.ok(stagedLabel < at('a.js') && at('a.js') < changesLabel, 'a.js 应属于「已暂存」组')
	assert.ok(changesLabel < at('b.js'), 'b.js 应属于「变更」组')
	// 冲突文件不能同时冒进「已暂存」组（解析器把 unmerged 判成 staged:true，靠 filter 排除）
	const stagedHeader = findHeader(panel, '已暂存', '全部取消暂存')
	assert.equal(collect(stagedHeader).texts.indexOf('both.js'), -1, '冲突文件不得出现在「已暂存」组')

	// 禁用而不是隐藏：让「为什么点不了」看得见，而不是按钮凭空消失
	const stageAll = buttons.find((b) => collect(b).texts.join('') === '全部暂存')
	assert.ok(stageAll, '「全部暂存」应仍然可见')
	assert.equal(stageAll.props.disabled, true, '有冲突时不得允许全部暂存（add -A 会标成已解决）')
	assert.match(String(stageAll.props.title), /冲突/)

	const unstageAll = buttons.find((b) => collect(b).texts.join('') === '全部取消暂存')
	assert.equal(unstageAll.props.disabled, true, '有冲突时也不得全部取消暂存（会丢掉冲突状态）')
})

check('没有冲突时不出现冲突分组与「Agent 解决冲突」', () => {
	const { nodes, texts } = collect(renderChanges(TWO_FILES))
	assert.equal(texts.filter((x) => x.indexOf('冲突状态') !== -1).length, 0, '不该有冲突分组')
	assert.equal(
		nodes.filter((n) => n.type === 'button' && collect(n).texts.join('') === 'Agent 解决冲突').length,
		0
	)
})

check('冲突行右端是不可点的「!」，而不是 −/+', () => {
	// 「先点 − 再点 +」= 把冲突文件送进「变更」组拿到 +，再 add ——
	// 实测提交进去的就是 <<<<<<< HEAD ... ======= ... >>>>>>> 这段标记文本。
	const panel = renderChanges(WITH_CONFLICT)
	const { nodes } = collect(panel)
	const rows = nodes.filter((n) => n.props && n.props['data-git-lite-hoverable'] === '')
	assert.ok(rows.length >= 3, '应渲染出三个文件行，实际 ' + rows.length)
	const rowOf = (p) => rows.find((r) => collect(r).texts.indexOf(p) !== -1)

	const conflictRow = rowOf('both.js')
	assert.ok(conflictRow, '找不到冲突文件行')
	const cTexts = collect(conflictRow).texts
	assert.ok(cTexts.indexOf('!') !== -1, '冲突行应有 ! 标记，实际：' + cTexts.join('|'))
	assert.equal(cTexts.indexOf('−'), -1, '冲突行不得有减号')
	assert.equal(cTexts.indexOf('+'), -1, '冲突行不得有加号')

	const bang = collect(conflictRow).nodes.find((n) => n.type === 'span' && collect(n).texts.join('') === '!')
	assert.ok(bang, '找不到 ! 节点')
	assert.equal(bang.props.onClick, undefined, '! 不该可点（它只表示「这里不能暂存」）')
	assert.ok(String(bang.props.title).length > 10, '! 应带 tooltip 说明为什么不能暂存')
	assert.ok(
		String(bang.props.style.color).indexOf('--dsw-alias-state-error-primary') !== -1,
		'! 应取错误色令牌，实际：' + bang.props.style.color
	)

	// 普通文件行不受影响
	assert.ok(collect(rowOf('b.js')).texts.indexOf('+') !== -1, '未暂存行应有 +')
	assert.ok(collect(rowOf('a.js')).texts.indexOf('−') !== -1, '已暂存行应有 −')
})

check('选中冲突文件时，详情区不提供「暂存 / 取消暂存」（后端也会拒绝）', () => {
	const withSel = (filesJson, selectedJson) =>
		renderPanel((s) =>
			s
				.replace(
					'var [status, setStatus] = React.useState(null)',
					'var [status, setStatus] = React.useState({branch:"main",files:' + filesJson + '})'
				)
				.replace(
					'var [selected, setSelected] = React.useState(null)',
					'var [selected, setSelected] = React.useState(' + selectedJson + ')'
				)
		)
	const labelsOf = (panel) =>
		collect(panel)
			.nodes.filter((n) => n.type === 'button')
			.map((b) => collect(b).texts.join(''))

	const conflict = labelsOf(withSel(WITH_CONFLICT, "{path:'both.js',staged:false}"))
	assert.equal(conflict.indexOf('暂存'), -1, '冲突文件不该有「暂存」')
	assert.equal(conflict.indexOf('取消暂存'), -1, '冲突文件不该有「取消暂存」')

	// 普通文件照旧：已暂存 → 「取消暂存」，未暂存 → 「暂存」
	assert.ok(labelsOf(withSel(TWO_FILES, "{path:'a.js',staged:true}")).indexOf('取消暂存') !== -1)
	assert.ok(labelsOf(withSel(TWO_FILES, "{path:'b.js',staged:false}")).indexOf('暂存') !== -1)
})

check('有冲突时「提交」按钮禁用并说明原因（禁止把 git 的英文 hint/fatal 丢给用户）', () => {
	// 真机反馈：只暂存了部分文件、没勾「全部暂存」就点提交 —— 宿主的冲突闸门当时只在
	// stageAll 分支里，于是 `git commit` 直接失败，面板红条里出现了
	// "error: Committing is not possible because you have unmerged files. hint: ... fatal: ..."
	const labelsOf = (panel) =>
		collect(panel)
			.nodes.filter((n) => n.type === 'button')

	const conflictCommit = labelsOf(renderChanges(WITH_CONFLICT)).find(
		(b) => collect(b).texts.join('') === '提交'
	)
	assert.ok(conflictCommit, '找不到「提交」按钮')
	assert.equal(conflictCommit.props.disabled, true, '有冲突时提交必须禁用（git 一定拒绝）')
	assert.match(String(conflictCommit.props.title), /冲突/)

	// 没有冲突时照旧可用，且浮层回到原本的说明
	const normalCommit = labelsOf(renderChanges(TWO_FILES)).find((b) => collect(b).texts.join('') === '提交')
	assert.equal(normalCommit.props.disabled, false)
	assert.equal(normalCommit.props.title.indexOf('冲突'), -1)
})

check('有文件 / 有冲突时渲染出的样式里同样没有 undefined（新按钮只在有文件时才渲染）', () => {
	// 上面那条 undefined 样式用例渲染的是空工作区，走不到新加的 MiniBtn 与冲突横幅
	for (const fixture of [TWO_FILES, WITH_CONFLICT]) {
		const { nodes } = collect(renderChanges(fixture))
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
	}
})

check('zh / en 字典的键一一对应（漏一个键只会渲染成空标签，逻辑测试发现不了）', () => {
	const zhAt = src.indexOf('zh: {')
	const enAt = src.indexOf('en: {')
	const end = src.indexOf('\n\t\t\t}\n\t\t}', enAt)
	assert.ok(zhAt > 0 && enAt > zhAt && end > enAt, '字典边界没找到，本用例需要跟着格式更新')
	const keysOf = (block) =>
		Array.from(block.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):/gm)).map((m) => m[1]).sort()
	const zhKeys = keysOf(src.slice(zhAt + 'zh: {'.length, enAt))
	const enKeys = keysOf(src.slice(enAt + 'en: {'.length, end))
	assert.deepEqual(zhKeys, enKeys, 'zh / en 字典键不一致')
	// 下限只是防止正则失配后「两个空数组也相等」把用例变成假绿
	assert.ok(zhKeys.length >= 55, '字典键数量异常：' + zhKeys.length)
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
	// sticky 需要**不透明**背景（否则滚动时下文透出来），所以取 bg-layer-1 令牌
	assert.ok(
		String(header.props.style.background).indexOf('--dsw-alias-bg-layer-1') !== -1,
		'sticky 背景应取 bg-layer-1 令牌，实际：' + header.props.style.background
	)
})

check('提交行是内缩圆角卡片，而不是通栏分隔线', () => {
	// 通栏分隔线会紧贴导轨起笔，与导轨一起把左侧糊成网格
	const { nodes } = collect(renderHistory())
	const card = nodes.find((n) => n.props && n.props['data-git-lite-commit'] === '')
	assert.ok(card, '找不到提交卡片')
	assert.equal(card.props.style.borderBottom, undefined, '卡片不应有通栏下边框')
	assert.equal(card.props.style.borderRadius, 6)
	assert.ok(
		card.props.style.border.indexOf('--dsw-alias-border-l2') !== -1,
		'卡片边框应取边框令牌，实际：' + card.props.style.border
	)
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
