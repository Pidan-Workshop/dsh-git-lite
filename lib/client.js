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
			return React.useMemo(
				function () {
					return dictFor(id)
				},
				[id]
			)
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
			var t = useDict(props.locale)
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
						setError(err.message)
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
					behind > 0 ? h('span', { style: { color: theme.dim, fontSize: 11, flex: '0 0 auto' } }, '↓' + behind) : null
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

				// ── 变更列表 ──
				h(
					'div',
					{ style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto' } },
					status === null
						? h('div', { style: { padding: 10, color: theme.dim } }, error ? '' : t.loading)
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
				),

				// ── diff ──
				h(
					'div',
					{
						style: {
							flex: '2 1 auto',
							minHeight: 110,
							display: 'flex',
							flexDirection: 'column',
							borderTop: '1px solid ' + theme.border
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
							selected ? selected.path : t.selectFile
						),
						selected
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
					),
					h(DiffView, { t: t, theme: theme, diff: diff.text, truncated: diff.truncated, loading: diff.loading })
				),

				// ── 提交区 ──
				// paddingBottom 按实测浮层动态内缩：面板底边不动，只把内容抬起来，
				// 因此测量基准稳定、不会与结果振荡。
				h(
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
				),

				confirmPush ? pushDialog(confirmPush) : null
			)
		}

		// ────────────────────────── 分支胶囊 ──────────────────────────

		function BranchChip(props) {
			var sessions = props.sessions
			var t = useDict(props.locale)
			var theme = makeTheme(useDark())
			var session = useSession(sessions)
			var sessionId = session.id
			var sessionCwd = session.cwd
			function api(path, body) {
				return call(path, Object.assign({ sessionId: sessionId, cwd: sessionCwd }, body))
			}
			var [brief, setBrief] = React.useState(null)

			React.useEffect(
				function () {
					if (!sessionId) {
						setBrief(null)
						return undefined
					}
					var alive = true
					function tick() {
						if (typeof document !== 'undefined' && document.hidden) return
						api('/status', { sessionId: sessionId })
							.then(function (v) {
								if (alive) setBrief(v)
							})
							.catch(function () {
								if (alive) setBrief(null)
							})
					}
					tick()
					var timer = setInterval(tick, POLL_MS * 2)
					return function () {
						alive = false
						clearInterval(timer)
					}
				},
				[sessionId]
			)

			if (!brief || !brief.branch) return null
			var dirty = (brief.files || []).length
			return h(
				'button',
				{
					type: 'button',
					title: t.guideTitle,
					onClick: function () {
						if (props.openTab) props.openTab()
					},
					style: {
						display: 'inline-flex',
						alignItems: 'center',
						gap: 4,
						padding: '2px 7px',
						fontSize: 11,
						fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
						color: theme.dim,
						background: 'transparent',
						border: '1px solid ' + theme.border,
						borderRadius: 999,
						cursor: 'pointer',
						lineHeight: '16px'
					}
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

			ctx.inject(['sidebarRightTabs', 'slots', 'sessions', 'locale'], function (scope) {
				try {
					scope.sidebarRightTabs.register({
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

					scope.slots.inject('sidebar.right.pane.tab', function () {
						return scope.slots.register(
							{
								name: 'sidebar.right.pane.tab',
								key: TAB_ID,
								inject: function () {
									return { sessions: scope.sessions, locale: scope.locale }
								}
							},
							GitTabBody
						)
					})

					scope.slots.inject('sidebar.right.pane.tab.title', function () {
						return scope.slots.register(
							{ name: 'sidebar.right.pane.tab.title', key: TAB_ID },
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

					console.log('dsh-git-lite: registered native sidebar tab')
				} catch (err) {
					console.warn('dsh-git-lite: sidebar tab registration failed', err)
				}
			})

			// 会话头部右对齐区的分支胶囊：面板的常驻入口。
			// 放在 conversation.session.header.utilities（右对齐列表）而不是
			// conversation.input.dock（输入框上方）—— 后者会额外占一行高度，
			// 而头部本来就有一片空着的右侧工具区。
			ctx.inject(['slots', 'sessions', 'locale', 'sidebarRight'], function (scope) {
				try {
					scope.slots.inject('conversation.session.header.utilities', function () {
						return scope.slots.register(
							{
								name: 'conversation.session.header.utilities',
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
				} catch (err) {
					console.warn('dsh-git-lite: header chip registration failed', err)
				}
			})
		}

		exports.apply = apply
		exports.inject = ['sessions', 'locale']
		// 仅用于单测：浏览器半区靠 __ModuleLoader__ 加载、无法在 Node 里常规 import，
		// 所以把纯函数挂在这里供 tests/client-smoke.mjs 取用。运行时无人读它。
		exports.__internals = {
			computeOverlayInset: computeOverlayInset,
			parseDiff: parseDiff,
			spanOfChildren: spanOfChildren
		}
		return module.exports
	}
})
