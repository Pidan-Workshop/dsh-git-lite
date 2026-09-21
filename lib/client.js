/**
 * dsh-git-lite —— 浏览器半区。
 *
 * 与 dsh 官方 client 插件同构：window.__ModuleLoader__.load 注册模块，
 * 导出 apply(ctx)/inject 供浏览器 cordis 运行器挂载。
 *
 * 三个注册点：
 *   1. sidebarRightTabs.register   —— 注册 tab 类型（kind: 'git-lite'）
 *   2. sidebar.right.pane.tab      —— 注册 tab 主体（keyed seat，key = TAB_ID）
 *   3. conversation.session.header.utilities
 *                                  —— 会话头部右对齐区的分支胶囊，点击打开面板
 *
 * 关于「提交」的两条路径（本插件刻意做的区分）：
 *   · 「提交」= 宿主直接 git commit，信息来自输入框（可先点 ✨ 让模型按 diff 生成；
 *     但那条路径只看得到"改了什么"，看不到"为什么改"）。
 *   · 「交给 Agent 提交」= 通过官方 ISession.prompt() 往当前会话投一条用户消息，
 *     由会话 agent 用完整对话上下文自己暂存/写信息/提交。它与"你亲手打字说
 *     『提交一下』"走同一条路径，信息质量与风格推断因此完全一致。
 */
window.__ModuleLoader__.load({
	id: 'dsh-git-lite',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports

		var React = require('react')
		var h = React.createElement

		var API = '/git-lite'
		var TAB_ID = 'git-lite'
		var TAB_KIND = 'git-lite'
		var POLL_MS = 3000
		/** 分支胶囊稳定后的轮询间隔。 */
		var CHIP_POLL_MS = 6000
		/**
		 * 还没拿到权威答复时（典型：切会话后宿主尚未把会话载入，返回 session-unknown）
		 * 的快重试间隔与次数上限。没有这个，胶囊会被 6 秒轮询周期卡住，表现为
		 * 「过一会才刷出来」。
		 */
		var CHIP_RETRY_MS = 500
		var CHIP_RETRY_MAX = 12

		/** 列表区高度的持久化键与拖拽 clamp 边界。 */
		var SPLIT_KEY = 'dsh-git-lite:list-height'
		var LIST_MIN = 56
		var DIFF_MIN = 90
		/** 提交历史每次拉取的条数。 */
		var LOG_PAGE = 50

		/**
		 * 下一次请求该等多久。
		 *
		 * 连续失败（会话尚未就绪）时快重试，成功或超过上限后回常规节奏。
		 * 抽成纯函数是因为「失败后不能再等 6 秒」正是曾经的真机回归：胶囊切会话时
		 * 要等一整个轮询周期才出现。见 tests/client-smoke.mjs。
		 *
		 * @param failures - 连续失败次数（0 = 上一次成功）
		 * @returns 毫秒
		 */
		function chipRetryDelay(failures) {
			return failures > 0 && failures <= CHIP_RETRY_MAX ? CHIP_RETRY_MS : CHIP_POLL_MS
		}

		/**
		 * 把分隔条拖拽的指针位置换算成「列表区高度」，并 clamp 到两侧都不塌陷。
		 *
		 * 抽成纯函数以便单测：clamp 的边界一旦写错，某一侧就会塌成 0 高度、
		 * 看起来像"内容不见了"——这是真机上最难自查的一类布局 bug。
		 *
		 * @param next - 指针相对面板顶部的偏移（期望的列表高度）
		 * @param bodyHeight - 列表+分隔条+diff 这个容器的总高度
		 * @param listMin - 列表区最小高度
		 * @param diffMin - diff 区最小高度
		 * @returns 列表区高度（整数）。空间不足时优先保住 diff 的最小高度。
		 */
		/**
		 * 提交时间显示为本地 `MM-DD HH:mm`。
		 *
		 * 刻意用绝对时间而不是「3 天前」：绝对时间无需时区/本地化处理、无需随渲染刷新，
		 * 而相对时间会在面板长时间开着时悄悄变旧。完整时间戳放在 title 里。
		 *
		 * @param iso - `git log --format=%aI` 给出的严格 ISO 8601
		 * @returns `MM-DD HH:mm`；无法解析时返回空串（宁可留白也不显示 NaN）
		 */
		function formatCommitTime(iso) {
			var d = new Date(iso)
			if (isNaN(d.getTime())) return ''
			function p(n) {
				return (n < 10 ? '0' : '') + n
			}
			return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
		}

		/**
		 * 本地日历日的键（`YYYY-MM-DD`）。无法解析时返回空串。
		 *
		 * 用**本地**日期而不是 UTC 切片：用户看到的提交时间是本地时间，分组也必须按
		 * 本地日切，否则晚上提交的会被分到前一天。
		 */
		function localDayKey(iso) {
			var d = new Date(iso)
			if (isNaN(d.getTime())) return ''
			function p(n) {
				return (n < 10 ? '0' : '') + n
			}
			return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
		}

		/**
		 * 分组标题用的日期文案（`2026年9月12日` / `Sep 12, 2026`）。
		 *
		 * 交给 Intl.DateTimeFormat 而不是手写月份名：自己维护十二个月的翻译是纯负担，
		 * 而 Intl 在浏览器与 Node 里都有。
		 */
		function formatDayLabel(iso, localeId) {
			var d = new Date(iso)
			if (isNaN(d.getTime())) return ''
			try {
				return new Intl.DateTimeFormat(localeId || 'zh', {
					year: 'numeric',
					month: 'short',
					day: 'numeric'
				}).format(d)
			} catch (err) {
				return localDayKey(iso)
			}
		}

		/**
		 * 按本地日历日把提交分组，**连续**同一天的归为一组（GitHub 仓库历史页的做法）。
		 *
		 * 只合并相邻项而不是全局归并：列表本来按时间倒序，全局归并会打乱顺序，也会让
		 * 分页追加时同一日期出现两个分组。
		 *
		 * @param commits - parseLog 产出的提交数组（含 date）
		 * @returns `[{ day, commits }]`；日期无法解析的项归入 day 为空串的那组
		 */
		function groupCommitsByDay(commits) {
			var groups = []
			var current = null
			for (var i = 0; i < commits.length; i++) {
				var c = commits[i]
				var day = localDayKey(c.date)
				if (current === null || current.day !== day) {
					current = { day: day, commits: [] }
					groups.push(current)
				}
				current.commits.push(c)
			}
			return groups
		}

		function clampListHeight(next, bodyHeight, listMin, diffMin) {
			var max = bodyHeight - diffMin
			// 容器矮到连两个最小高度都放不下：让列表先让位，diff 保持可读。
			if (max <= listMin) return Math.max(0, Math.floor(max))
			return Math.round(Math.min(max, Math.max(listMin, next)))
		}

		/**
		 * 胶囊该渲染哪种状态。
		 *
		 * 抽成纯函数是因为真机回归全出在状态切换上（「老对话没有胶囊」「要等 6 秒才出现」），
		 * 而这四个分支的判定条件很容易写反。
		 *
		 * `loading` 的语义刻意收窄为「**本会话首次加载**尚未拿到任何答复」：
		 * 切会话时组件会先清空（见 BranchChip 的 effect），而瞬态失败不清理 brief，
		 * 所以轮询抖动不会把胶囊打回加载态来回闪。
		 *
		 * @param brief - `/status` 的成功结果；带 branch 才算 ready
		 * @param briefErr - 宿主给出的**权威**错误文案；null 表示尚无答复
		 * @param sessionId - 当前会话 id
		 * @returns 'ready' | 'norepo' | 'loading' | 'idle'
		 */
		function chipState(brief, briefErr, sessionId) {
			if (brief && brief.branch) return 'ready'
			if (briefErr) return 'norepo'
			// 没有会话不是「正在加载」，而是没有可加载的对象：不占位。
			if (!sessionId) return 'idle'
			return 'loading'
		}

		/**
		 * 宿主答复出错时，胶囊该怎么动。
		 *
		 * 这里有个必须区分、又极易写反的两分：
		 *   · **权威**错误（`not-a-repo` / `no-workspace` / `workspace-unknown` / …）
		 *     意味着「这个目录确实没有可用仓库」→ 清掉旧的分支信息，显示弱化胶囊。
		 *   · **瞬态**错误（`session-unknown`：切会话时宿主还没载入；或无 code 的网络抖动）
		 *     意味着「还不知道」→ **保留上一次的分支信息**。否则每次轮询抖动都会把胶囊
		 *     打回加载态。同一会话的仓库不会变，保留旧值的风险只是短暂不新鲜。
		 *
		 * @param err - 宿主 `call()` 抛出的错误（可能带 .code）
		 * @returns {{clearBrief: boolean, errorText: string|null}}
		 */
		function onStatusFailure(err) {
			var code = err && err.code
			if (code && code !== 'session-unknown') {
				return { clearBrief: true, errorText: err.message }
			}
			return { clearBrief: false, errorText: null }
		}

		// ────────────────────────── i18n ──────────────────────────

		var DICT = {
			zh: {
				tab: 'Git',
				guideTitle: '查看 Git 改动',
				guideDesc: '变更列表、diff、拉取与推送',
				noSession: '请先选择一个会话',
				loading: '加载中…',
				clean: '工作区干净',
				staged: '已暂存',
				changes: '变更',
				untracked: '未跟踪',
				conflicted: '冲突',
				fetch: '抓取',
				pull: '拉取',
				push: '推送',
				refresh: '刷新',
				stashPush: '暂存改动',
				stashPop: '恢复暂存',
				commitPlaceholder: '提交信息…',
				generate: '✨ 生成信息',
				commit: '提交',
				delegate: '交给 Agent 提交',
				stageAll: '全部暂存',
				stage: '暂存',
				unstage: '取消暂存',
				selectFile: '点击上方文件查看改动',
				noDiff: '（无差异内容）',
				diffTruncated: '（diff 过长已截断）',
				pushTitle: '确认推送',
				pushAhead: '个提交',
				pushConfirm: '确认推送',
				cancel: '取消',
				delegated: '已把提交任务交给当前会话的 Agent',
				noRepo: '无仓库',
				dragHint: '拖动调整上下高度，双击复位',
				modeChanges: '变更',
				modeLog: '历史',
				noCommits: '暂无提交',
				loadMore: '加载更早的 50 条',
				back: '← 返回',
				filesChanged: '个文件',
				allFiles: '全部文件（完整 patch）',
				selectCommit: '选择一条提交查看改动',
				commitsOn: '{date} 的提交',
				switching: '切换中…',
				working: '执行中…'
			},
			en: {
				tab: 'Git',
				guideTitle: 'View Git changes',
				guideDesc: 'Changes, diff, pull and push',
				noSession: 'Select a session first',
				loading: 'Loading…',
				clean: 'Working tree clean',
				staged: 'Staged',
				changes: 'Changes',
				untracked: 'Untracked',
				conflicted: 'Conflicted',
				fetch: 'Fetch',
				pull: 'Pull',
				push: 'Push',
				refresh: 'Refresh',
				stashPush: 'Stash',
				stashPop: 'Pop stash',
				commitPlaceholder: 'Commit message…',
				generate: '✨ Generate',
				commit: 'Commit',
				delegate: 'Let Agent commit',
				stageAll: 'Stage all',
				stage: 'Stage',
				unstage: 'Unstage',
				selectFile: 'Pick a file above to see its diff',
				noDiff: '(no diff content)',
				diffTruncated: '(diff truncated)',
				pushTitle: 'Confirm push',
				pushAhead: 'commits',
				pushConfirm: 'Confirm push',
				cancel: 'Cancel',
				delegated: 'Commit task handed to this session\'s agent',
				noRepo: 'no repo',
				dragHint: 'Drag to resize, double-click to reset',
				modeChanges: 'Changes',
				modeLog: 'History',
				noCommits: 'No commits yet',
				loadMore: 'Load 50 more',
				back: '← Back',
				filesChanged: 'files',
				allFiles: 'All files (full patch)',
				selectCommit: 'Pick a commit to see its diff',
				commitsOn: 'Commits on {date}',
				switching: 'Switching…',
				working: 'Working…'
			}
		}

		function dictFor(localeId) {
			return String(localeId || '').toLowerCase().indexOf('zh') === 0 ? DICT.zh : DICT.en
		}

		/** 从 LocaleRuntime 读当前语言 id。 */
		function readLocaleId(locale) {
			try {
				if (locale && typeof locale.getLocale === 'function') {
					var snap = locale.getLocale()
					if (snap && snap.active) return snap.active
				}
			} catch {
				/* 落到下面的兜底 */
			}
			if (typeof locale === 'string') return locale
			if (typeof navigator !== 'undefined' && navigator.language) return navigator.language
			return 'zh'
		}

		/** 订阅语言切换，界面文案随 DSH 语言实时变化。 */
		function useDict(locale) {
			var id = React.useSyncExternalStore(
				function (cb) {
					return typeof locale.subscribe === 'function' ? locale.subscribe(cb) : function () {}
				},
				function () {
					return readLocaleId(locale)
				}
			)
			var dict = React.useMemo(
				function () {
					return dictFor(id)
				},
				[id]
			)
			// 一并返回语言 id：日期分组标题要交给 Intl 做本地化。
			return { dict: dict, id: id }
		}

		// ────────────────────────── 主题 ──────────────────────────

		function useDark() {
			var [dark, setDark] = React.useState(function () {
				if (typeof window === 'undefined' || !window.matchMedia) return false
				return window.matchMedia('(prefers-color-scheme: dark)').matches
			})
			React.useEffect(function () {
				if (typeof window === 'undefined' || !window.matchMedia) return undefined
				var mq = window.matchMedia('(prefers-color-scheme: dark)')
				var onChange = function (e) {
					setDark(e.matches)
				}
				mq.addEventListener('change', onChange)
				return function () {
					mq.removeEventListener('change', onChange)
				}
			}, [])
			return dark
		}

		function makeTheme(dark) {
			return {
				fg: dark ? '#e6edf3' : '#1f2328',
				dim: dark ? '#9198a1' : '#656d76',
				border: dark ? '#30363d' : '#d0d7de',
				panel: dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
				popover: dark ? '#161b22' : '#ffffff',
				scrim: dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.75)',
				accent: dark ? '#4493f8' : '#0969da',
				add: dark ? '#3fb950' : '#1a7f37',
				del: dark ? '#f85149' : '#cf222e',
				hunk: dark ? '#a371f7' : '#8250df',
				addBg: dark ? 'rgba(63,185,80,0.13)' : 'rgba(26,127,55,0.08)',
				delBg: dark ? 'rgba(248,81,73,0.13)' : 'rgba(207,34,46,0.08)'
			}
		}

		// ────────────────────── 避开第三方固定浮层 ──────────────────────

		/**
		 * 纯几何：算出操作行底部需要内缩多少，才能避开与它横向相交的固定浮层。
		 *
		 * 抽成纯函数是因为这段判断只在浏览器里生效、却最容易写错（横向与纵向两个条件
		 * 缺一不可），纯函数至少能单测。见 tests/client-smoke.mjs。
		 *
		 * 为什么用「按钮的实际跨度」而不是容器宽度：容器是 flex-wrap 的整行，宽度永远
		 * 撑满面板。若按容器算，全屏时按钮明明挤在左边、右侧全是空白，也会判定相交并
		 * 白白让出空间。
		 *
		 * @param input.panelBottom - 提交区外底边（稳定值：给它加 padding 不会移动这条边）
		 * @param input.rowLeft - 操作行内按钮的实际左边界
		 * @param input.rowRight - 操作行内按钮的实际右边界
		 * @param input.viewportHeight - 视口高度，用于排除「整块面板」而非「悬浮按钮」
		 * @param input.maxInset - 内缩上限，避免全屏浮层把操作区挤没
		 * @param input.overlays - 候选浮层 [{ top, left, right, height }]
		 * @returns 需要的底部内缩像素（整数，已 clamp）
		 */
		function computeOverlayInset(input) {
			var need = 0
			var list = input.overlays || []
			for (var i = 0; i < list.length; i++) {
				var o = list[i]
				// 整块面板不参与避让：它盖住时本来也点不到，让位只是浪费空间。
				if (o.height > input.viewportHeight * 0.4) continue
				// 横向必须与按钮真正相交。
				var hOverlap = Math.min(input.rowRight, o.right) - Math.max(input.rowLeft, o.left)
				if (hOverlap <= 0) continue
				// 纵向：浮层顶边压到提交区底边多少。
				var vOverlap = input.panelBottom - o.top
				if (vOverlap <= 0) continue
				if (vOverlap > need) need = vOverlap
			}
			return Math.min(input.maxInset, Math.ceil(need))
		}

		/** 一行子元素的视觉并集横向跨度；没有可用子元素时退回容器自身。 */
		function spanOfChildren(row) {
			var rect = row.getBoundingClientRect()
			var kids = row.children || []
			var left = Infinity
			var right = -Infinity
			for (var i = 0; i < kids.length; i++) {
				var r = kids[i].getBoundingClientRect()
				if (r.width === 0 || r.height === 0) continue
				if (r.left < left) left = r.left
				if (r.right > right) right = r.right
			}
			if (left === Infinity) return { left: rect.left, right: rect.right }
			return { left: left, right: right }
		}

		/**
		 * 实测固定浮层，返回操作区需要的底部内缩量。
		 *
		 * 只检查 document.body 的**直接子元素**中 computed position 为 fixed 的那些 ——
		 * 悬浮按钮几乎总是挂在 body 下；这样避免遍历整棵树并逐节点取 computed style。
		 *
		 * 触发时机：挂载、窗口 resize、body 直接子元素增删（MutationObserver，覆盖
		 * 「浮层后出现/后消失」）。纵向基准用提交区的外底边而非操作行自身，因为给它加
		 * padding 不会移动这条边，测量与结果因此不会互相反馈、不会振荡。
		 */
		function useOverlayInset(panelRef, rowRef) {
			var [inset, setInset] = React.useState(0)
			React.useEffect(
				function () {
					if (typeof document === 'undefined' || typeof window === 'undefined') return undefined
					var frame = 0
					var MAX_INSET = 240

					function measure() {
						frame = 0
						var panel = panelRef.current
						var row = rowRef.current
						if (!panel || !row) return
						var panelRect = panel.getBoundingClientRect()
						if (panelRect.height === 0) return
						var span = spanOfChildren(row)

						var overlays = []
						var kids = document.body ? document.body.children : []
						for (var i = 0; i < kids.length; i++) {
							var node = kids[i]
							if (node === panel || node.contains(panel)) continue
							if (typeof node.getBoundingClientRect !== 'function') continue
							if (window.getComputedStyle(node).position !== 'fixed') continue
							var r = node.getBoundingClientRect()
							if (r.width === 0 || r.height === 0) continue
							overlays.push({ top: r.top, left: r.left, right: r.right, height: r.height })
						}

						setInset(
							computeOverlayInset({
								panelBottom: panelRect.bottom,
								rowLeft: span.left,
								rowRight: span.right,
								viewportHeight: window.innerHeight,
								maxInset: MAX_INSET,
								overlays: overlays
							})
						)
					}

					function schedule() {
						if (frame !== 0) return
						frame = window.requestAnimationFrame(measure)
					}

					schedule()
					window.addEventListener('resize', schedule)
					var mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(schedule) : null
					if (mo !== null && document.body) mo.observe(document.body, { childList: true })
					return function () {
						window.removeEventListener('resize', schedule)
						if (frame !== 0) window.cancelAnimationFrame(frame)
						if (mo !== null) mo.disconnect()
					}
				},
				[panelRef, rowRef]
			)
			return inset
		}

		// ────────────────────────── 宿主接口 ──────────────────────────

		/**
		 * 调宿主路由。宿主统一返回 { ok, value } 或 { ok, error }。
		 * 失败时抛出带 .code 的 Error，交由调用方展示。
		 */
		function call(path, body) {
			return fetch(API + path, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body || {}),
				cache: 'no-store'
			})
				.then(function (r) {
					return r.json().catch(function () {
						return { ok: false, error: { code: 'bad-response', message: 'HTTP ' + r.status } }
					})
				})
				.then(function (payload) {
					if (payload && payload.ok) return payload.value
					var err = (payload && payload.error) || { code: 'unknown', message: 'unknown error' }
					var e = new Error(err.message || err.code)
					e.code = err.code
					throw e
				})
		}

		/**
		 * 当前会话的 id 与工作目录。
		 * 与官方一致，订阅 sessions.list 的 observable 快照；cwd 取自 SessionSummary。
		 * 上报 cwd 只是为了兜底宿主 header 缺 cwd 的会话 —— 宿主仍会过工作区闸门。
		 */
		function useSession(sessions) {
			var snap = React.useSyncExternalStore(
				function (cb) {
					return sessions.list.subscribe(cb)
				},
				function () {
					return sessions.list.getSnapshot()
				}
			)
			var id = snap ? snap.current : undefined
			var summary = id !== undefined && snap && snap.byId ? snap.byId[id] : undefined
			return { id: id, cwd: summary ? summary.cwd : undefined }
		}

		// ────────────────────────── 通用 UI ──────────────────────────

		function Btn(props) {
			var t = props.t
			var disabled = props.disabled || props.busy
			return h(
				'button',
				{
					type: 'button',
					title: props.title || props.label,
					disabled: disabled,
					onClick: props.onClick,
					style: {
						display: 'inline-flex',
						alignItems: 'center',
						gap: 4,
						padding: '3px 8px',
						fontSize: 11,
						fontFamily: 'inherit',
						lineHeight: '18px',
						color: props.primary ? '#fff' : t.fg,
						background: props.primary ? t.accent : 'transparent',
						border: '1px solid ' + (props.primary ? t.accent : t.border),
						borderRadius: 6,
						cursor: disabled ? 'default' : 'pointer',
						opacity: disabled ? 0.5 : 1,
						whiteSpace: 'nowrap'
					}
				},
				props.busy ? t.working : props.label
			)
		}

		/**
		 * 两段式切换控件（变更 / 历史）。
		 * 不用原生 select：分段控件的语义是「视图切换」而不是「选值」，且只有两个互斥项。
		 */
		function Segmented(props) {
			var theme = props.theme
			return h(
				'div',
				{
					role: 'tablist',
					style: {
						display: 'inline-flex',
						flex: '0 0 auto',
						border: '1px solid ' + theme.border,
						borderRadius: 6,
						overflow: 'hidden'
					}
				},
				props.options.map(function (o) {
					var active = o.value === props.value
					return h(
						'button',
						{
							key: o.value,
							type: 'button',
							role: 'tab',
							'aria-selected': active,
							onClick: function () {
								if (!active) props.onChange(o.value)
							},
							style: {
								font: 'inherit',
								fontSize: 11,
								lineHeight: '18px',
								padding: '1px 7px',
								color: active ? '#fff' : theme.fg,
								background: active ? theme.accent : 'transparent',
								border: 'none',
								cursor: active ? 'default' : 'pointer',
								whiteSpace: 'nowrap'
							}
						},
						o.label
					)
				})
			)
		}

		/**
		 * 历史列表左侧的时间轴导轨（GitHub 仓库历史页的做法）。
		 *
		 * 实现要点：**每一行各自画一小段竖线**，行与行首尾相接就成了一条连续导轨。
		 * 这样不必去测量整个列表的高度，也不必用绝对定位把一条长线钉在容器上；
		 * 日期分组标题是 sticky 的，长线方案在吸顶时还会错位。
		 *
		 * @param theme - 当前主题
		 * @param hasNode - 该行是否画节点（只有分组标题画）
		 */
		function railGutter(theme, hasNode) {
			return h(
				'div',
				{ style: { flex: '0 0 18px', position: 'relative', alignSelf: 'stretch' } },
				// 竖线：撑满本行
				h('span', {
					style: {
						position: 'absolute',
						left: '50%',
						top: 0,
						bottom: 0,
						width: 1,
						marginLeft: -0.5,
						background: theme.border
					}
				}),
				hasNode
					? h('span', {
							// 节点：空心圆，背景用不透明色把竖线"咬断"，看起来像串在线上
							style: {
								position: 'absolute',
								left: '50%',
								top: '50%',
								width: 9,
								height: 9,
								marginTop: -4.5,
								marginLeft: -4.5,
								boxSizing: 'border-box',
								borderRadius: '50%',
								border: '1.5px solid ' + theme.dim,
								background: theme.popover
							}
						})
					: null,
				hasNode
					? h('span', {
							// 节点右侧的短横线，与标题文字衔接
							style: {
								position: 'absolute',
								left: '50%',
								top: '50%',
								width: 7,
								height: 1,
								marginTop: -0.5,
								marginLeft: 6,
								background: theme.dim,
								opacity: 0.5
							}
						})
					: null
			)
		}

		function GitIcon(props) {
			var size = props && props.size ? props.size : 14
			return h(
				'svg',
				{
					viewBox: '0 0 16 16',
					width: size,
					height: size,
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.6,
					strokeLinecap: 'round',
					strokeLinejoin: 'round'
				},
				h('circle', { cx: 4, cy: 4, r: 2 }),
				h('circle', { cx: 4, cy: 12, r: 2 }),
				h('circle', { cx: 12, cy: 8, r: 2 }),
				h('path', { d: 'M4 6v4M4 8h5a3 3 0 013 3' })
			)
		}

		var SPIN_STYLE_ID = 'dsh-git-lite-spin-style'

		/**
		 * 注入一次旋转动画。插件没有 CSS 管线，只能内联一个 keyframes；
		 * 用固定 id 保证幂等（多个胶囊实例、多次渲染都只注入一次）。
		 */
		function ensureSpinnerStyle() {
			if (typeof document === 'undefined' || !document.head) return
			if (document.getElementById(SPIN_STYLE_ID) !== null) return
			var el = document.createElement('style')
			el.id = SPIN_STYLE_ID
			el.textContent = '@keyframes dsh-git-lite-spin{to{transform:rotate(360deg)}}'
			document.head.appendChild(el)
		}

		/** 加载指示：一个纯 CSS 旋转的圆环。 */
		function Spinner() {
			ensureSpinnerStyle()
			return h('span', {
				'aria-hidden': 'true',
				style: {
					display: 'inline-block',
					width: 9,
					height: 9,
					border: '1.5px solid currentColor',
					borderTopColor: 'transparent',
					borderRadius: '50%',
					animation: 'dsh-git-lite-spin .7s linear infinite'
				}
			})
		}

		function statusCodeOf(file) {
			if (file.untracked) return '?'
			if (file.unmerged) return 'U'
			return file.staged ? file.index : file.worktree
		}

		function StatusLetter(props) {
			var t = props.t
			var code = statusCodeOf(props.file)
			var color = t.dim
			if (code === 'U' || code === 'D') color = t.del
			else if (code === '?' || code === 'A') color = t.add
			return h(
				'span',
				{
					style: {
						display: 'inline-block',
						width: 13,
						textAlign: 'center',
						fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
						fontSize: 11,
						fontWeight: 600,
						color: color,
						flex: '0 0 auto'
					}
				},
				code
			)
		}

		var META_PREFIXES = [
			'index ',
			'new file',
			'deleted file',
			'similarity index',
			'rename ',
			'old mode',
			'new mode',
			'Binary files'
		]

		function parseDiff(text) {
			var out = []
			var lines = String(text).split('\n')
			for (var i = 0; i < lines.length; i++) {
				var line = lines[i]
				var kind = 'ctx'
				if (line.indexOf('@@') === 0) kind = 'hunk'
				else if (line.indexOf('diff --git') === 0 || line.indexOf('+++') === 0 || line.indexOf('---') === 0) kind = 'meta'
				else {
					for (var m = 0; m < META_PREFIXES.length; m++) {
						if (line.indexOf(META_PREFIXES[m]) === 0) {
							kind = 'meta'
							break
						}
					}
					if (kind === 'ctx') {
						if (line.charAt(0) === '+') kind = 'add'
						else if (line.charAt(0) === '-') kind = 'del'
					}
				}
				out.push({ kind: kind, text: line })
			}
			if (out.length > 0 && out[out.length - 1].text === '') out.pop()
			return out
		}

		function DiffView(props) {
			var t = props.t
			var theme = props.theme
			var lines = React.useMemo(
				function () {
					return parseDiff(props.diff || '')
				},
				[props.diff]
			)

			if (props.loading) {
				return h('div', { style: { padding: 10, fontSize: 12, color: theme.dim } }, t.loading)
			}
			if (lines.length === 0) {
				return h('div', { style: { padding: 10, fontSize: 12, color: theme.dim } }, t.noDiff)
			}
			return h(
				'div',
				{
					style: {
						flex: '1 1 auto',
						minHeight: 0,
						overflow: 'auto',
						fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
						fontSize: 11,
						lineHeight: '17px'
					}
				},
				props.truncated
					? h(
							'div',
							{ style: { padding: '3px 8px', color: theme.dim, fontStyle: 'italic' } },
							t.diffTruncated
						)
					: null,
				lines.map(function (l, i) {
					var bg = 'transparent'
					var color = theme.fg
					if (l.kind === 'add') {
						bg = theme.addBg
						color = theme.add
					} else if (l.kind === 'del') {
						bg = theme.delBg
						color = theme.del
					} else if (l.kind === 'hunk') {
						color = theme.hunk
					} else if (l.kind === 'meta') {
						color = theme.dim
					}
					return h(
						'div',
						{
							key: i,
							style: { background: bg, color: color, padding: '0 8px', whiteSpace: 'pre' }
						},
						l.text === '' ? '\u00a0' : l.text
					)
				})
			)
		}

		// ────────────────────────── 主面板 ──────────────────────────

		function GitTabBody(props) {
			var sessions = props.sessions
			var loc = useDict(props.locale)
			var t = loc.dict
			var localeId = loc.id
			var theme = makeTheme(useDark())

			var session = useSession(sessions)
			var sessionId = session.id
			var sessionCwd = session.cwd
			/** 所有宿主调用都带上 sessionId 与 cwd（cwd 是宿主无权威值时的兜底）。 */
			function api(path, body) {
				return call(path, Object.assign({ sessionId: sessionId, cwd: sessionCwd }, body))
			}

			var [status, setStatus] = React.useState(null)
			var [error, setError] = React.useState(null)
			var [notice, setNotice] = React.useState(null)
			var [busy, setBusy] = React.useState(null)
			var [selected, setSelected] = React.useState(null)
			var [diff, setDiff] = React.useState({ text: '', truncated: false, loading: false })
			var [diffNonce, setDiffNonce] = React.useState(0)
			var [message, setMessage] = React.useState('')
			var [stageAll, setStageAll] = React.useState(false)
			var [confirmPush, setConfirmPush] = React.useState(null)
			var [branches, setBranches] = React.useState(null)

			// 提交区与操作行的 ref：供 useOverlayInset 实测第三方固定浮层并让位。
			var commitRef = React.useRef(null)
			var rowRef = React.useRef(null)
			var overlayInset = useOverlayInset(commitRef, rowRef)

			// ── 列表 / diff 的高度分配 ──────────────────────────────
			// 默认用 flex 比例（两侧各占一半）；用户拖过分隔条之后，改为固定列表高度。
			// 只存列表高度而不是分别存两个：diff 自动吃掉剩余空间，容器尺寸变化时
			// 不会出现两侧之和超过容器的情况。
			var bodyRef = React.useRef(null)
			var draggingRef = React.useRef(false)
			var [listHeight, setListHeight] = React.useState(function () {
				try {
					if (typeof window === 'undefined' || !window.localStorage) return null
					var raw = window.localStorage.getItem(SPLIT_KEY)
					if (raw === null) return null
					var n = Number(raw)
					return Number.isFinite(n) && n > 0 ? n : null
				} catch (err) {
					return null
				}
			})
			var [dragging, setDragging] = React.useState(false)

			// 历史模式的状态。三层的下钻在这里只体现为两个变量：
			//   logState   提交列表（第 1 层）
			//   commitView 选中的提交（含其文件清单与完整 patch，第 2 层）
			//   commitFile 该提交里选中的文件（第 3 层；null 表示看整条提交的 patch）
			// 布局因此仍是「两个区域 + 一条分隔条」，不需要第三个纵向区域。
			var [mode, setMode] = React.useState('changes')
			var [logState, setLogState] = React.useState(null)
			var [commitView, setCommitView] = React.useState(null)
			var [commitFile, setCommitFile] = React.useState(null)

			// 拖拽结束后持久化一次（不在 move 里写，避免每帧一次 localStorage 写入）。
			React.useEffect(
				function () {
					if (dragging || listHeight === null) return
					try {
						window.localStorage.setItem(SPLIT_KEY, String(listHeight))
					} catch (err) {
						/* 隐私模式等场景下写入会失败，忽略即可 */
					}
				},
				[listHeight, dragging]
			)

			// 容器变矮时把已保存的高度重新 clamp 回来，否则列表会溢出、diff 被压没。
			React.useEffect(
				function () {
					if (typeof window === 'undefined') return undefined
					function reclamp() {
						var body = bodyRef.current
						if (!body) return
						setListHeight(function (prev) {
							if (prev === null) return prev
							var next = clampListHeight(prev, body.getBoundingClientRect().height, LIST_MIN, DIFF_MIN)
							return next === prev ? prev : next
						})
					}
					window.addEventListener('resize', reclamp)
					return function () {
						window.removeEventListener('resize', reclamp)
					}
				},
				[]
			)

			function onSplitterDown(e) {
				e.preventDefault()
				draggingRef.current = true
				setDragging(true)
				try {
					e.currentTarget.setPointerCapture(e.pointerId)
				} catch (err) {
					/* 不支持指针捕获时退化为普通拖拽 */
				}
			}

			function onSplitterMove(e) {
				if (!draggingRef.current) return
				var body = bodyRef.current
				if (!body) return
				var rect = body.getBoundingClientRect()
				setListHeight(clampListHeight(e.clientY - rect.top, rect.height, LIST_MIN, DIFF_MIN))
			}

			function onSplitterUp(e) {
				if (!draggingRef.current) return
				draggingRef.current = false
				setDragging(false)
				try {
					e.currentTarget.releasePointerCapture(e.pointerId)
				} catch (err) {
					/* 同上 */
				}
			}

			/** 双击分隔条：清掉自定义高度，回到默认比例。 */
			function resetSplit() {
				setListHeight(null)
				try {
					window.localStorage.removeItem(SPLIT_KEY)
				} catch (err) {
					/* 忽略 */
				}
			}

			// ── 提交历史（历史模式）──────────────────────────────────
			/** 拉取提交列表；append=true 时追加下一页。 */
			function loadLog(append) {
				var skip = append && logState !== null ? logState.commits.length : 0
				return run('log', api('/log', { skip: skip, limit: LOG_PAGE })).then(function (value) {
					if (!value) return
					setLogState(function (prev) {
						return {
							commits: append && prev !== null ? prev.commits.concat(value.commits) : value.commits,
							hasMore: value.hasMore
						}
					})
				})
			}

			/** 打开一条提交：一次往返同时拿到文件清单和完整 patch。 */
			function openCommit(c) {
				setCommitFile(null)
				setCommitView({
					sha: c.sha,
					short: c.short,
					subject: c.subject,
					diff: '',
					truncated: false,
					files: [],
					loading: true
				})
				run('show', api('/show', { sha: c.sha })).then(function (value) {
					if (!value) {
						setCommitView(null)
						return
					}
					setCommitView({
						sha: c.sha,
						short: c.short,
						subject: c.subject,
						diff: value.diff,
						truncated: value.truncated,
						files: value.files || [],
						loading: false
					})
				})
			}

			/** 下钻到该提交里的某个文件。 */
			function pickCommitFile(path) {
				setCommitFile({ path: path, diff: '', truncated: false, loading: true })
				run('show', api('/show', { sha: commitView.sha, path: path })).then(function (value) {
					if (!value) {
						setCommitFile(null)
						return
					}
					setCommitFile({ path: path, diff: value.diff, truncated: value.truncated, loading: false })
				})
			}

			/** 从「某提交的文件」退回「提交列表」。 */
			function backToLog() {
				setCommitView(null)
				setCommitFile(null)
			}

			// 进入历史模式（或换会话）时重新拉第一页：历史随时会被外部操作改变，
			// 而且「加载更多」的进度不值得跨模式保留。
			React.useEffect(
				function () {
					if (mode !== 'log' || !sessionId) return
					setLogState(null)
					setCommitView(null)
					setCommitFile(null)
					loadLog(false)
				},
				[mode, sessionId]
			)

			function report(err) {
				setError(err && err.message ? err.message : String(err))
				setNotice(null)
			}

			function ok(text) {
				setNotice(text || null)
				setError(null)
			}

			/** 统一管理 busy 与错误。 */
			function run(key, promise) {
				setBusy(key)
				setError(null)
				return promise
					.catch(function (err) {
						report(err)
						return undefined
					})
					.finally(function () {
						setBusy(null)
					})
			}

			/** 刷新状态；返回 promise 便于串联。 */
			function refreshStatus() {
				return api('/status', { sessionId: sessionId })
					.then(function (value) {
						setStatus(value)
						setError(null)
					})
					.catch(function (err) {
						setStatus(null)
						// session-unknown 表示会话尚未载入（切会话时的瞬态），
						// 此时报红条只会误导；面板保持「加载中」即可。
						setError(err.code === 'session-unknown' ? null : err.message)
					})
			}

			React.useEffect(
				function () {
					setStatus(null)
					setSelected(null)
					setConfirmPush(null)
					setBranches(null)
					if (!sessionId) return undefined
					refreshStatus()
					var timer = setInterval(function () {
						if (typeof document !== 'undefined' && document.hidden) return
						refreshStatus()
					}, POLL_MS)
					return function () {
						clearInterval(timer)
					}
				},
				[sessionId]
			)

			// 拉选中文件的 diff。只在选中项或显式 nonce 变化时重取，避免轮询闪烁。
			React.useEffect(
				function () {
					if (!sessionId || !selected) {
						setDiff({ text: '', truncated: false, loading: false })
						return undefined
					}
					var alive = true
					setDiff({ text: '', truncated: false, loading: true })
					api('/diff', { sessionId: sessionId, path: selected.path, staged: selected.staged })
						.then(function (value) {
							if (alive) setDiff({ text: value.diff, truncated: value.truncated, loading: false })
						})
						.catch(function (err) {
							if (alive) {
								setDiff({ text: '', truncated: false, loading: false })
								report(err)
							}
						})
					return function () {
						alive = false
					}
				},
				[sessionId, selected, diffNonce]
			)

			if (!sessionId) {
				return h('div', { style: { padding: 12, fontSize: 12, color: theme.dim } }, t.noSession)
			}

			var files = (status && status.files) || []
			var stagedFiles = files.filter(function (f) {
				return f.staged
			})
			var otherFiles = files.filter(function (f) {
				return !f.staged
			})
			var ahead = (status && status.ahead) || 0
			var behind = (status && status.behind) || 0

			function afterMutation() {
				setDiffNonce(function (n) {
					return n + 1
				})
				return refreshStatus()
			}

			function onStage(file) {
				run('stage', api('/stage', { sessionId: sessionId, path: file.path })).then(afterMutation)
			}

			function onUnstage(file) {
				run('unstage', api('/unstage', { sessionId: sessionId, path: file.path })).then(afterMutation)
			}

			function onPush() {
				run('push-preview', api('/push/preview', { sessionId: sessionId })).then(function (value) {
					if (value) setConfirmPush(value)
				})
			}

			function onPushConfirm() {
				var token = confirmPush && confirmPush.token
				run('push-confirm', api('/push/confirm', { sessionId: sessionId, token: token })).then(function (value) {
					if (value) {
						setConfirmPush(null)
						ok(value.output || t.pushConfirm)
						return refreshStatus()
					}
					// 失败时关掉弹层：token 已被单次消费，留在界面上只会反复失败。
					setConfirmPush(null)
					return undefined
				})
			}

			function onGenerate() {
				run('message', api('/message', { sessionId: sessionId })).then(function (value) {
					if (value && value.message) setMessage(value.message)
				})
			}

			function onCommit() {
				run('commit', api('/commit', { sessionId: sessionId, message: message, stageAll: stageAll })).then(
					function (value) {
						if (value) {
							setMessage('')
							ok('commit ' + value.head)
							setSelected(null)
							return refreshStatus()
						}
						return undefined
					}
				)
			}

			/**
			 * 交给当前会话的 agent 提交：官方 ISession.prompt()，等价于用户自己打字。
			 * 这条路径能看到完整对话上下文与仓库既有提交风格。
			 */
			function onDelegate() {
				var binding = sessions.binding(sessionId)
				if (!binding || !binding.session) {
					report(new Error('no session binding'))
					return
				}
				var trimmed = message.trim()
				var text =
					trimmed !== ''
						? '请查看当前工作区的改动并提交。提交信息用：' + trimmed
						: '请查看当前工作区的改动并提交（自行判断该暂存哪些文件，提交信息按仓库既有风格撰写）。'
				setError(null)
				binding.session
					.prompt([{ type: 'text', text: text }], 'queue')
					.then(function () {
						ok(t.delegated)
						setMessage('')
					})
					.catch(report)
			}

			function onFetch() {
				run('fetch', api('/fetch', { sessionId: sessionId })).then(function (value) {
					if (value) {
						ok(value.output)
						return refreshStatus()
					}
					return undefined
				})
			}

			function onPull() {
				run('pull', api('/pull', { sessionId: sessionId })).then(function (value) {
					if (value) {
						ok(value.output || t.pull)
						return afterMutation()
					}
					return undefined
				})
			}

			function onStash(action) {
				run('stash', api('/stash', { sessionId: sessionId, action: action })).then(function (value) {
					if (value) {
						ok(value.output || t.stashPush)
						return afterMutation()
					}
					return undefined
				})
			}

			function onCheckout(branch) {
				run('checkout', api('/checkout', { sessionId: sessionId, branch: branch })).then(function (value) {
					if (value) {
						ok(branch)
						return afterMutation()
					}
					return undefined
				})
			}

			function loadBranches() {
				if (branches !== null) return
				api('/branches', { sessionId: sessionId })
					.then(function (value) {
						setBranches(value)
					})
					.catch(report)
			}

			// ── 样式 ──
			var rowStyle = {
				display: 'flex',
				alignItems: 'center',
				gap: 6,
				padding: '2px 8px',
				fontSize: 12,
				cursor: 'pointer'
			}
			// 日期分组标题：sticky 吸顶（GitHub 历史页同理），因此背景必须不透明，
			// 否则滚动时下面的提交会透出来。
			var groupHeaderStyle = {
				display: 'flex',
				alignItems: 'center',
				padding: '5px 8px',
				fontSize: 10,
				color: theme.dim,
				background: theme.popover,
				borderBottom: '1px solid ' + theme.border,
				position: 'sticky',
				top: 0,
				zIndex: 1
			}
			var sectionStyle = {
				padding: '4px 8px',
				fontSize: 10,
				letterSpacing: '0.06em',
				textTransform: 'uppercase',
				color: theme.dim
			}

			function sectionLabel(list) {
				if (list.some(function (f) { return f.unmerged })) return t.conflicted
				if (list.some(function (f) { return f.untracked })) return t.changes + ' / ' + t.untracked
				return t.changes
			}

			function fileRow(file, isStaged) {
				var isSel = selected !== null && selected.path === file.path && selected.staged === isStaged
				return h(
					'div',
					{
						key: (isStaged ? 's:' : 'w:') + file.path,
						onClick: function () {
							setSelected({ path: file.path, staged: isStaged })
						},
						style: Object.assign({}, rowStyle, {
							background: isSel ? theme.panel : 'transparent',
							borderLeft: isSel ? '2px solid ' + theme.accent : '2px solid transparent'
						}),
						title: file.path
					},
					h(StatusLetter, { t: t, file: file }),
					h(
						'span',
						{
							style: {
								flex: '1 1 auto',
								minWidth: 0,
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								whiteSpace: 'nowrap',
								direction: 'rtl',
								textAlign: 'left'
							}
						},
						file.path
					),
					file.additions !== null && file.additions !== undefined
						? h('span', { style: { color: theme.add, fontSize: 10, flex: '0 0 auto' } }, '+' + file.additions)
						: null,
					file.deletions !== null && file.deletions !== undefined
						? h('span', { style: { color: theme.del, fontSize: 10, flex: '0 0 auto' } }, '-' + file.deletions)
						: null,
					h(
						'span',
						{
							onClick: function (e) {
								e.stopPropagation()
								if (isStaged) onUnstage(file)
								else onStage(file)
							},
							title: isStaged ? t.unstage : t.stage,
							style: {
								flex: '0 0 auto',
								padding: '0 4px',
								cursor: 'pointer',
								color: theme.dim,
								fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
								fontWeight: 700
							}
						},
						isStaged ? '−' : '+'
					)
				)
			}

			function pushDialog(plan) {
				return h(
					'div',
					{
						style: {
							position: 'absolute',
							inset: 0,
							background: theme.scrim,
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							padding: 12,
							zIndex: 50
						}
					},
					h(
						'div',
						{
							style: {
								background: theme.popover,
								border: '1px solid ' + theme.border,
								borderRadius: 10,
								padding: 12,
								maxWidth: 420,
								width: '100%',
								boxShadow: '0 8px 28px rgba(0,0,0,0.28)'
							}
						},
						h('div', { style: { fontWeight: 600, fontSize: 12, marginBottom: 6 } }, t.pushTitle),
						h(
							'div',
							{
								style: {
									fontSize: 11,
									color: theme.dim,
									marginBottom: 6,
									fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
									wordBreak: 'break-word'
								}
							},
							plan.branch + ' → ' + plan.upstream + '  (' + plan.ahead + ' ' + t.pushAhead + ', ' + plan.head + ')'
						),
						h(
							'div',
							{ style: { maxHeight: 160, overflow: 'auto', marginBottom: 8, fontSize: 11 } },
							(plan.commits || []).map(function (c) {
								return h(
									'div',
									{ key: c.sha, style: { display: 'flex', gap: 6, padding: '1px 0' } },
									h('code', { style: { color: theme.dim, flex: '0 0 auto' } }, c.sha),
									h(
										'span',
										{ style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
										c.subject
									)
								)
							})
						),
						h(
							'div',
							{ style: { display: 'flex', gap: 6, justifyContent: 'flex-end' } },
							h(Btn, {
								t: t,
								label: t.cancel,
								disabled: busy !== null,
								onClick: function () {
									setConfirmPush(null)
								}
							}),
							h(Btn, {
								t: t,
								label: t.pushConfirm,
								primary: true,
								busy: busy === 'push-confirm',
								disabled: busy !== null,
								onClick: onPushConfirm
							})
						)
					)
				)
			}

			/** 变更模式：改动文件列表（含首次加载与空态）。 */
			function changesListContent() {
				return 					status === null
							? error
								? null // 错误已由上方红条展示，这里不再重复
								: h(
										'div',
										{
											style: {
												padding: 10,
												color: theme.dim,
												display: 'flex',
												alignItems: 'center',
												gap: 6
											}
										},
										h(Spinner, null),
										t.loading
									)
							: files.length === 0
								? h('div', { style: { padding: 10, color: theme.dim } }, t.clean)
								: [].concat(
										stagedFiles.length > 0
											? [h('div', { key: 'sh', style: sectionStyle }, t.staged)].concat(
													stagedFiles.map(function (f) {
														return fileRow(f, true)
													})
												)
											: [],
										otherFiles.length > 0
											? [h('div', { key: 'ch', style: sectionStyle }, sectionLabel(otherFiles))].concat(
													otherFiles.map(function (f) {
														return fileRow(f, false)
													})
												)
											: []
									)
			}

			/** 历史模式第 1 层：提交列表 + 分页。 */
			function commitListContent() {
				if (logState === null) {
					return h(
						'div',
						{ style: { padding: 10, color: theme.dim, display: 'flex', alignItems: 'center', gap: 6 } },
						h(Spinner, null),
						t.loading
					)
				}
				if (logState.commits.length === 0) {
					return h('div', { style: { padding: 10, color: theme.dim } }, t.noCommits)
				}
				// 按本地日历日分组（GitHub 仓库历史页的做法）。只合并**相邻**同日：
				// 列表本就是时间倒序，全局归并会打乱顺序，也会让分页追加时同一天出现两组。
				var out = []
				groupCommitsByDay(logState.commits).forEach(function (g, gi) {
					out.push(
						h(
							'div',
							{ key: 'g' + gi },
							// 分组标题行：导轨 + 节点 + 标题
							h(
								'div',
								{ style: groupHeaderStyle },
								railGutter(theme, true),
								h(
									'span',
									{ style: { paddingLeft: 8 } },
									t.commitsOn.replace('{date}', formatDayLabel(g.commits[0].date, localeId))
								)
							),
							// 该分组的提交：同一根导轨从左侧继续向下
							h(
								'div',
								{ style: { display: 'flex', padding: '0 8px' } },
								railGutter(theme, false),
								h(
									'div',
									{ style: { flex: '1 1 auto', minWidth: 0 } },
									g.commits.map(commitRow)
								)
							)
						)
					)
				})
				if (logState.hasMore) {
					out.push(h(
											'button',
											{
												key: 'more',
												type: 'button',
												disabled: busy !== null,
												onClick: function () {
													loadLog(true)
												},
												style: {
													display: 'block',
													width: '100%',
													padding: '7px 8px',
													font: 'inherit',
													fontSize: 11,
													textAlign: 'center',
													color: theme.fg,
													background: 'transparent',
													border: 'none',
													borderTop: '1px solid ' + theme.border,
													cursor: busy !== null ? 'default' : 'pointer',
													opacity: busy !== null ? 0.5 : 1
												}
											},
											busy === 'log' ? t.loading : t.loadMore
										))
				}
				return out
			}

			/** 一条提交：上行 sha + 标题，下行 refs 徽标 + 作者 + 时间。 */
			function commitRow(c) {
				return h(
					'div',
					{
						key: c.sha,
						title: c.sha + (c.date !== '' ? '\n' + c.date : ''),
						onClick: function () {
							openCommit(c)
						},
						style: {
							padding: '4px 0',
							cursor: 'pointer',
							borderBottom: '1px solid ' + theme.border
						}
					},
					h(
						'div',
						{ style: { display: 'flex', gap: 6, alignItems: 'baseline' } },
						h(
							'code',
							{
								style: {
									flex: '0 0 auto',
									fontSize: 10,
									color: theme.dim,
									fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'
								}
							},
							c.short
						),
						h(
							'span',
							{
								style: {
									flex: '1 1 auto',
									minWidth: 0,
									fontSize: 11,
									overflow: 'hidden',
									textOverflow: 'ellipsis',
									whiteSpace: 'nowrap'
								}
							},
							c.subject
						)
					),
					h(
						'div',
						{
							style: {
								display: 'flex',
								gap: 4,
								alignItems: 'center',
								flexWrap: 'wrap',
								marginTop: 2,
								fontSize: 10,
								color: theme.dim
							}
						},
						(c.refs || []).map(function (r) {
							var isHead = r.indexOf('HEAD') === 0
							return h(
								'span',
								{
									key: r,
									style: {
										padding: '0 4px',
										borderRadius: 999,
										border: '1px solid ' + (isHead ? theme.accent : theme.border),
										color: isHead ? theme.accent : theme.dim
									}
								},
								r
							)
						}),
						h('span', null, c.author),
						h('span', null, formatCommitTime(c.date))
					)
				)
			}

			/** 历史模式第 2 层：该提交的文件列表（含返回与「全部文件」）。 */
			function commitDetailContent() {
				var view = commitView
				var head = [
					h(
						'div',
						{
							key: 'hdr',
							style: {
								display: 'flex',
								alignItems: 'center',
								gap: 6,
								padding: '4px 8px',
								borderBottom: '1px solid ' + theme.border
							}
						},
						h(Btn, { t: t, label: t.back, onClick: backToLog }),
						h(
							'code',
							{
								style: {
									fontSize: 10,
									color: theme.dim,
									fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'
								}
							},
							view.short
						)
					),
					h(
						'div',
						{
							key: 'subj',
							style: {
								padding: '4px 8px',
								fontSize: 11,
								borderBottom: '1px solid ' + theme.border,
								wordBreak: 'break-word'
							}
						},
						view.subject
					),
					h(
						'div',
						{
							key: 'all',
							onClick: function () {
								setCommitFile(null)
							},
							style: {
								padding: '3px 8px',
								fontSize: 11,
								cursor: 'pointer',
								borderLeft: commitFile === null ? '2px solid ' + theme.accent : '2px solid transparent',
								background: commitFile === null ? theme.panel : 'transparent',
								color: commitFile === null ? theme.accent : theme.fg
							}
						},
						t.allFiles
					)
				]
				if (view.loading) {
					return head.concat([
						h(
							'div',
							{
								key: 'loading',
								style: { padding: 10, color: theme.dim, display: 'flex', alignItems: 'center', gap: 6 }
							},
							h(Spinner, null),
							t.loading
						)
					])
				}
				return head.concat(
					view.files.map(function (f) {
						var active = commitFile !== null && commitFile.path === f.path
						return h(
							'div',
							{
								key: f.path,
								title: f.oldPath !== null ? f.oldPath + ' → ' + f.path : f.path,
								onClick: function () {
									pickCommitFile(f.path)
								},
								style: Object.assign({}, rowStyle, {
									background: active ? theme.panel : 'transparent',
									borderLeft: active ? '2px solid ' + theme.accent : '2px solid transparent'
								})
							},
							h(
								'span',
								{
									style: {
										display: 'inline-block',
										width: 13,
										textAlign: 'center',
										fontSize: 11,
										fontWeight: 600,
										flex: '0 0 auto',
										fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
										color: f.status === 'D' ? theme.del : f.status === 'A' ? theme.add : theme.dim
									}
								},
								f.status
							),
							h(
								'span',
								{
									style: {
										flex: '1 1 auto',
										minWidth: 0,
										overflow: 'hidden',
										textOverflow: 'ellipsis',
										whiteSpace: 'nowrap',
										direction: 'rtl',
										textAlign: 'left'
									}
								},
								f.path
							),
							f.additions !== null
								? h('span', { style: { color: theme.add, fontSize: 10, flex: '0 0 auto' } }, '+' + f.additions)
								: null,
							f.deletions !== null
								? h('span', { style: { color: theme.del, fontSize: 10, flex: '0 0 auto' } }, '-' + f.deletions)
								: null
						)
					})
				)
			}

			// 下方区域是否有内容可显示：
			//   变更模式 —— 选了文件才有 diff；历史模式 —— 选了提交才有 patch。
			// 没有内容时整块隐藏（连分隔条一起），把高度全让给列表，而不是让一个
			// 空 diff 区白占半屏。
			var hasBottom = mode === 'changes' ? selected !== null : commitView !== null

			// 下方区域的标题 / 操作 / 内容按模式决定，渲染处只读这几个变量。
			var bottomTitle
			var bottomAction
			var bottomDiff
			var bottomTruncated
			var bottomLoading
			if (mode === 'changes') {
				bottomTitle = selected ? selected.path : t.selectFile
				bottomAction = selected
					? h(Btn, {
							t: t,
							label: selected.staged ? t.unstage : t.stage,
							disabled: busy !== null,
							onClick: function () {
								if (selected.staged) onUnstage({ path: selected.path })
								else onStage({ path: selected.path })
							}
						})
					: null
				bottomDiff = diff.text
				bottomTruncated = diff.truncated
				bottomLoading = diff.loading
			} else if (commitView === null) {
				// 历史第 1 层：还没选提交
				bottomTitle = t.selectCommit
				bottomAction = null
				bottomDiff = ''
				bottomTruncated = false
				bottomLoading = false
			} else if (commitFile !== null) {
				// 历史第 3 层：某个文件
				bottomTitle = commitFile.path
				bottomAction = h(Btn, {
					t: t,
					label: t.allFiles,
					disabled: busy !== null,
					onClick: function () {
						setCommitFile(null)
					}
				})
				bottomDiff = commitFile.diff
				bottomTruncated = commitFile.truncated
				bottomLoading = commitFile.loading
			} else {
				// 历史第 2 层：整条提交的完整 patch
				bottomTitle = commitView.short + '  ' + commitView.subject
				bottomAction = null
				bottomDiff = commitView.diff
				bottomTruncated = commitView.truncated
				bottomLoading = commitView.loading
			}

			var branchOptions = status && status.branch ? [status.branch].concat(
				(branches && branches.local ? branches.local : [])
					.map(function (b) {
						return b.name
					})
					.filter(function (n) {
						return n !== (status && status.branch)
					})
			) : []

			return h(
				'div',
				{
					style: {
						position: 'relative',
						display: 'flex',
						flexDirection: 'column',
						height: '100%',
						minHeight: 0,
						color: theme.fg,
						fontSize: 12
					}
				},

				// ── 头部：分支下拉 + ahead/behind ──
				h(
					'div',
					{
						style: {
							display: 'flex',
							alignItems: 'center',
							gap: 6,
							padding: '6px 8px',
							borderBottom: '1px solid ' + theme.border,
							flex: '0 0 auto'
						}
					},
					h(
						'select',
						{
							value: status && status.branch ? status.branch : '',
							onFocus: loadBranches,
							onMouseDown: loadBranches,
							onChange: function (e) {
								if (e.target.value) onCheckout(e.target.value)
							},
							disabled: busy !== null,
							title: status && status.root ? status.root : '',
							style: {
								flex: '1 1 auto',
								minWidth: 0,
								fontSize: 11,
								fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
								color: theme.fg,
								background: theme.panel,
								border: '1px solid ' + theme.border,
								borderRadius: 6,
								padding: '2px 4px'
							}
						},
						branchOptions.length === 0
							? h('option', { value: '' }, '—')
							: branchOptions.map(function (name) {
									return h('option', { key: name, value: name }, name)
								})
					),
					ahead > 0 ? h('span', { style: { color: theme.accent, fontSize: 11, flex: '0 0 auto' } }, '↑' + ahead) : null,
					behind > 0 ? h('span', { style: { color: theme.dim, fontSize: 11, flex: '0 0 auto' } }, '↓' + behind) : null,
					h(Segmented, {
						key: 'mode',
						theme: theme,
						value: mode,
						onChange: setMode,
						options: [
							{ value: 'changes', label: t.modeChanges },
							{ value: 'log', label: t.modeLog }
						]
					})
				),

				// ── 操作条 ──
				h(
					'div',
					{
						style: {
							display: 'flex',
							flexWrap: 'wrap',
							gap: 4,
							padding: '6px 8px',
							borderBottom: '1px solid ' + theme.border,
							flex: '0 0 auto'
						}
					},
					h(Btn, { t: t, label: t.pull, busy: busy === 'pull', disabled: busy !== null, onClick: onPull }),
					h(Btn, { t: t, label: t.fetch, busy: busy === 'fetch', disabled: busy !== null, onClick: onFetch }),
					h(Btn, {
						t: t,
						label: t.push + (ahead > 0 ? ' ↑' + ahead : ''),
						primary: ahead > 0,
						busy: busy === 'push-preview',
						disabled: busy !== null || ahead === 0,
						onClick: onPush
					}),
					h(Btn, { t: t, label: t.refresh, disabled: busy !== null, onClick: refreshStatus }),
					h(Btn, {
						t: t,
						label: t.stashPush,
						busy: busy === 'stash',
						disabled: busy !== null,
						onClick: function () {
							onStash('push')
						}
					}),
					h(Btn, {
						t: t,
						label: t.stashPop,
						disabled: busy !== null,
						onClick: function () {
							onStash('pop')
						}
					})
				),

				// ── 提示行 ──
				error
					? h(
							'div',
							{
								style: {
									padding: '5px 8px',
									fontSize: 11,
									color: theme.del,
									background: theme.delBg,
									borderBottom: '1px solid ' + theme.border,
									flex: '0 0 auto',
									wordBreak: 'break-word'
								}
							},
							error
						)
					: null,
				!error && notice
					? h(
							'div',
							{
								style: {
									padding: '5px 8px',
									fontSize: 11,
									color: theme.dim,
									borderBottom: '1px solid ' + theme.border,
									flex: '0 0 auto',
									wordBreak: 'break-word'
								}
							},
							notice
						)
					: null,

				// ── 上方区域 + 分隔条 + diff ───────────────────────────
				// 三者包在一个容器里，让分隔条能把容器高度按需分配给上下两区。
				// 列表默认与 diff 均分（原先 diff 独占 2/3，把列表压到只剩两行）。
				h(
					'div',
					{
						ref: bodyRef,
						style: {
							flex: '1 1 auto',
							minHeight: 0,
							overflow: 'hidden',
							display: 'flex',
							flexDirection: 'column',
							userSelect: dragging ? 'none' : 'auto'
						}
					},
					// ── 上方区域：按模式切换内容 ──
					// 变更模式 = 改动文件列表；历史模式 = 提交列表，或下钻后的「某提交的文件列表」。
					h(
						'div',
						{
							style: {
								flex: !hasBottom || listHeight === null ? '1 1 0' : '0 0 ' + listHeight + 'px',
								minHeight: 0,
								overflow: 'auto'
							}
						},
						mode === 'changes'
							? changesListContent()
							: commitView !== null
								? commitDetailContent()
								: commitListContent()
					),
					// 分隔条：仅在有下方内容时出现（否则列表独占高度）
					hasBottom
						? h('div', {
							role: 'separator',
							'aria-orientation': 'horizontal',
							title: t.dragHint,
							onPointerDown: onSplitterDown,
							onPointerMove: onSplitterMove,
							onPointerUp: onSplitterUp,
							onPointerCancel: onSplitterUp,
							onDoubleClick: resetSplit,
							style: {
								flex: '0 0 auto',
								height: 6,
								cursor: 'row-resize',
								background: dragging ? theme.accent : 'transparent',
								borderTop: '1px solid ' + theme.border,
								borderBottom: '1px solid ' + theme.border,
								opacity: dragging ? 0.6 : 1
							}
						})
						: null,

					// 下方区域：仅在有内容时渲染（未选文件 / 未选提交时整块让位）
					hasBottom
						? h(
							'div',
							{
								style: {
									flex: '1 1 0',
									minHeight: DIFF_MIN,
									display: 'flex',
									flexDirection: 'column'
								}
							},
							h(
								'div',
								{
									style: {
										display: 'flex',
										alignItems: 'center',
										gap: 6,
										padding: '4px 8px',
										borderBottom: '1px solid ' + theme.border,
										flex: '0 0 auto'
									}
								},
								h(
									'span',
									{
										style: {
											flex: '1 1 auto',
											minWidth: 0,
											fontSize: 11,
											color: theme.dim,
											overflow: 'hidden',
											textOverflow: 'ellipsis',
											whiteSpace: 'nowrap',
											direction: 'rtl',
											textAlign: 'left',
											fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'
										}
									},
									bottomTitle
								),
								bottomAction
							),
							h(DiffView, {
								t: t,
								theme: theme,
								diff: bottomDiff,
								truncated: bottomTruncated,
								loading: bottomLoading
							})
						)
						: null

				),

				// ── 提交区（仅变更模式显示；历史模式下列表与详情已占满空间）──
				// paddingBottom 按实测浮层动态内缩：面板底边不动，只把内容抬起来，
				// 因此测量基准稳定、不会与结果振荡。
				mode === 'changes'
					? h(
						'div',
						{
							ref: commitRef,
							style: {
								flex: '0 0 auto',
								borderTop: '1px solid ' + theme.border,
								padding: '6px 8px',
								paddingBottom: 6 + overlayInset + 'px',
								display: 'flex',
								flexDirection: 'column',
								gap: 5
							}
						},
						h('textarea', {
							value: message,
							placeholder: t.commitPlaceholder,
							onChange: function (e) {
								setMessage(e.target.value)
							},
							rows: 2,
							style: {
								width: '100%',
								boxSizing: 'border-box',
								resize: 'vertical',
								fontSize: 11,
								fontFamily: 'inherit',
								color: theme.fg,
								background: theme.panel,
								border: '1px solid ' + theme.border,
								borderRadius: 6,
								padding: '4px 6px'
							}
						}),
						h(
							'label',
							{ style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: theme.dim } },
							h('input', {
								type: 'checkbox',
								checked: stageAll,
								onChange: function (e) {
									setStageAll(e.target.checked)
								}
							}),
							t.stageAll
						),
						h(
							'div',
							{ ref: rowRef, style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
							h(Btn, { t: t, label: t.generate, busy: busy === 'message', disabled: busy !== null, onClick: onGenerate }),
							h(Btn, { t: t, label: t.commit, primary: true, busy: busy === 'commit', disabled: busy !== null, onClick: onCommit }),
							h(Btn, { t: t, label: t.delegate, disabled: busy !== null, onClick: onDelegate, title: t.delegate })
						)
					)
					: null,

				confirmPush ? pushDialog(confirmPush) : null
			)
		}

		// ────────────────────────── 分支胶囊 ──────────────────────────

		function BranchChip(props) {
			var sessions = props.sessions
			var loc = useDict(props.locale)
			var t = loc.dict
			var localeId = loc.id
			var theme = makeTheme(useDark())
			var session = useSession(sessions)
			var sessionId = session.id
			var sessionCwd = session.cwd
			function api(path, body) {
				return call(path, Object.assign({ sessionId: sessionId, cwd: sessionCwd }, body))
			}
			var [brief, setBrief] = React.useState(null)
			var [briefErr, setBriefErr] = React.useState(null)

			React.useEffect(
				function () {
					// 无条件先清空：切会话时上一个会话的分支信息对新会话是**错的**。
					// 这也让 loading 精确等于「本会话首次加载尚未拿到答复」。
					setBrief(null)
					setBriefErr(null)
					if (!sessionId) return undefined
					var alive = true
					var timer = 0
					var failures = 0

					function clear() {
						if (timer !== 0) {
							clearTimeout(timer)
							timer = 0
						}
					}

					function schedule(ms) {
						clear()
						timer = setTimeout(function () {
							timer = 0
							// 页面隐藏时不做请求，但按常规节奏续排，避免隐藏期间空转。
							if (typeof document !== 'undefined' && document.hidden) return schedule(CHIP_POLL_MS)
							tick()
						}, ms)
					}

					function tick() {
						api('/status', { sessionId: sessionId })
							.then(function (v) {
								if (!alive) return
								setBrief(v)
								setBriefErr(null)
								failures = 0
								schedule(chipRetryDelay(failures))
							})
							.catch(function (err) {
								if (!alive) return
								var verdict = onStatusFailure(err)
								if (verdict.clearBrief) {
									// 权威答复：这个目录确实没有可用仓库 → 清掉旧信息，显示弱化胶囊。
									setBrief(null)
									setBriefErr(verdict.errorText)
								}
								// 否则（session-unknown / 网络抖动）：**保留上一次的分支信息**，
								// 不把胶囊打回加载态，避免轮询抖动导致来回闪。
								// 慢在被 6 秒轮询周期卡住：未就绪期间快重试，就绪后立刻出现。
								failures += 1
								schedule(chipRetryDelay(failures))
							})
					}

					tick()
					return function () {
						alive = false
						clear()
					}
				},
				[sessionId]
			)

			var state = chipState(brief, briefErr, sessionId)

			// 没有会话：没什么可加载的，不占位。
			if (state === 'idle') return null

			function openTab() {
				if (props.openTab) props.openTab()
			}

			var chipBase = {
				display: 'inline-flex',
				alignItems: 'center',
				gap: 4,
				padding: '2px 7px',
				fontSize: 11,
				color: theme.dim,
				background: 'transparent',
				borderRadius: 999,
				cursor: 'pointer',
				lineHeight: '16px'
			}

			// 本会话首次加载尚未拿到答复：显示加载态，而不是留半秒空白。
			// （只在此刻出现——切会话会清空，而瞬态失败保留旧值，所以不会来回闪。）
			if (state === 'loading') {
				return h(
					'button',
					{
						type: 'button',
						title: t.loading,
						onClick: openTab,
						style: Object.assign({}, chipBase, {
							fontFamily: 'inherit',
							border: '1px solid ' + theme.border,
							opacity: 0.7
						})
					},
					h(Spinner, null),
					t.loading
				)
			}

			// 宿主明确回答「这里没有可用仓库」：弱化胶囊，原因放进 tooltip。
			//   （更早这里是静默 return null —— 用户无法区分「没有仓库」和「插件坏了」。）
			if (state === 'norepo') {
				return h(
					'button',
					{
						type: 'button',
						title: briefErr,
						onClick: openTab,
						style: Object.assign({}, chipBase, {
							fontFamily: 'inherit',
							border: '1px dashed ' + theme.border,
							opacity: 0.65
						})
					},
					h(GitIcon, { size: 11 }),
					t.noRepo
				)
			}

			// 有仓库：正常胶囊。
			var dirty = (brief.files || []).length
			return h(
				'button',
				{
					type: 'button',
					title: t.guideTitle,
					onClick: openTab,
					style: Object.assign({}, chipBase, {
						fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
						border: '1px solid ' + theme.border
					})
				},
				h(GitIcon, { size: 11 }),
				brief.branch,
				dirty > 0 ? h('span', { style: { color: theme.accent } }, '*' + dirty) : null,
				brief.ahead > 0 ? h('span', null, '↑' + brief.ahead) : null,
				brief.behind > 0 ? h('span', null, '↓' + brief.behind) : null
			)
		}

		// ────────────────────────── 插件体 ──────────────────────────

		function apply(ctx) {
			var t = dictFor(readLocaleId(ctx.locale))

			/**
			 * 把一次注册挂到插件的 effect 上。
			 *
			 * 这是 **HMR 安全的关键**，不是可选的整洁。侧边栏 tab 注册表的契约原文：
			 *   "The caller holds the returned disposer inside its own `ctx.effect`,
			 *    so a type's registration lives exactly as long as the plugin that
			 *    contributed it."
			 * 丢弃 disposer 会让注册活过本代插件；热重载后 apply 再跑一遍就会撞上
			 * `tab type id "git-lite" is already registered` —— 而那一抛会连带跳过
			 * 同一个 try 块里后续的注册。这正是「Git 标签页显示 tab.unavailable」的
			 * 真正成因：类型注册抛了，主体与标题两个 seat 因此都没注册上。
			 *
			 * 每次注册各自成一个 effect：一个失败不连累其余。
			 */
			function hang(label, setup) {
				ctx.effect(function () {
					try {
						return setup()
					} catch (err) {
						console.warn('dsh-git-lite: ' + label + ' registration failed', err)
						return undefined
					}
				}, 'dsh-git-lite: ' + label)
			}

			/** 注册一个 keyed seat 的占用者，返回其 disposer（交给 hang 挂上）。 */
			function claimSeat(scope, seat, options, component) {
				return scope.slots.inject(seat, function () {
					return scope.slots.register(Object.assign({ name: seat }, options), component)
				})
			}

			// ── 1) tab 类型 ──────────────────────────────────────────
			ctx.inject(['sidebarRightTabs'], function (scope) {
				hang('tab type', function () {
					return scope.sidebarRightTabs.register({
						id: TAB_ID,
						kind: TAB_KIND,
						priority: 'extension',
						title: function () {
							return t.tab
						},
						// guide 五件套齐全，工作区启动卡才与官方卡片对齐。
						guide: [
							{
								id: TAB_ID,
								order: 20,
								title: function () {
									return t.guideTitle
								},
								description: function () {
									return t.guideDesc
								},
								icon: GitIcon
							}
						]
					})
				})
			})

			// ── 2) tab 主体与标题 ────────────────────────────────────
			// 用最少的依赖（只要 slots/sessions/locale），尽早订阅 seat 声明。
			ctx.inject(['slots', 'sessions', 'locale'], function (scope) {
				hang('pane body', function () {
					return claimSeat(
						scope,
						'sidebar.right.pane.tab',
						{
							key: TAB_ID,
							inject: function () {
								return { sessions: scope.sessions, locale: scope.locale }
							}
						},
						GitTabBody
					)
				})
				hang('pane title', function () {
					return claimSeat(
						scope,
						'sidebar.right.pane.tab.title',
						{ key: TAB_ID },
						function () {
							return h(
								'span',
								{ style: { display: 'flex', alignItems: 'center', gap: 5 } },
								h(GitIcon, { size: 13 }),
								h('span', null, t.tab)
							)
						}
					)
				})
			})

			// ── 3) 会话头部右对齐区的分支胶囊 ────────────────────────
			// 放在 conversation.session.header.utilities（右对齐列表）而不是
			// conversation.input.dock（输入框上方）—— 后者会额外占一行高度，
			// 而头部本来就有一片空着的右侧工具区。
			ctx.inject(['slots', 'sessions', 'locale', 'sidebarRight'], function (scope) {
				hang('header chip', function () {
					return claimSeat(
						scope,
						'conversation.session.header.utilities',
						{
							id: 'git-lite-header-branch',
							order: 100,
							inject: function () {
								return {
									sessions: scope.sessions,
									locale: scope.locale,
									openTab: function () {
										scope.sidebarRight.openTab(TAB_KIND)
									}
								}
							}
						},
						BranchChip
					)
				})
			})
		}

		exports.apply = apply
		exports.inject = ['sessions', 'locale']
		// 仅用于单测：浏览器半区靠 __ModuleLoader__ 加载、无法在 Node 里常规 import，
		// 所以把纯函数挂在这里供 tests/client-smoke.mjs 取用。运行时无人读它。
		exports.__internals = {
			clampListHeight: clampListHeight,
			formatDayLabel: formatDayLabel,
			groupCommitsByDay: groupCommitsByDay,
			localDayKey: localDayKey,
			formatCommitTime: formatCommitTime,
			computeOverlayInset: computeOverlayInset,
			chipRetryDelay: chipRetryDelay,
			chipState: chipState,
			onStatusFailure: onStatusFailure,
			parseDiff: parseDiff,
			spanOfChildren: spanOfChildren
		}
		return module.exports
	}
})
