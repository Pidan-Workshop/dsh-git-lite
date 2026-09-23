/**
 * 宿主半区冒烟测试：不需要 DSH 运行时，只验证纯函数与插件装配形状。
 *   node tests/host-smoke.mjs
 */
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	apply,
	buildUserMessage,
	conflictPaths,
	conflictShape,
	conflictDiffNote,
	inject,
	isUnmergedPath,
	mergeCommitFiles,
	name,
	normalizeConfig,
	parseLog,
	parseStatus,
	resolveRepo,
	streamToText
} from '../lib/index.js'

let passed = 0
function check(label, fn) {
	fn()
	passed += 1
	console.log(`  ✓ ${label}`)
}

/** 异步用例：check 是同步的，异步断言必须等完再计数。 */
async function acheck(label, fn) {
	await fn()
	passed += 1
	console.log(`  ✓ ${label}`)
}

console.log('dsh-git-lite host smoke')

// ── parseStatus ────────────────────────────────────────────────
// `git status --porcelain=v2 --branch -z` 的真实形状：NUL 分隔，
// 重命名的原路径是紧随其后的独立 token。
const SAMPLE = [
	'# branch.oid abc123def456',
	'# branch.head main',
	'# branch.upstream origin/main',
	'# branch.ab +2 -1',
	'1 M. N... 100644 100644 100644 aaa bbb src/a.js',
	'1 .M N... 100644 100644 100644 aaa bbb src/b.js',
	'2 R. N... 100644 100644 100644 aaa bbb R100 src/new.js',
	'src/old.js',
	'? untracked.txt'
].join('\0') + '\0'

check('解析分支/上游/head', () => {
	const s = parseStatus(SAMPLE)
	assert.equal(s.branch, 'main')
	assert.equal(s.upstream, 'origin/main')
	assert.equal(s.head, 'abc123def456')
	assert.equal(s.detached, false)
})

check('解析 ahead/behind', () => {
	const s = parseStatus(SAMPLE)
	assert.equal(s.ahead, 2)
	assert.equal(s.behind, 1)
})

check('解析 4 个文件条目', () => {
	const s = parseStatus(SAMPLE)
	assert.equal(s.files.length, 4)
})

check('已暂存条目：staged 真 / unstaged 假', () => {
	const f = parseStatus(SAMPLE).files[0]
	assert.equal(f.path, 'src/a.js')
	assert.equal(f.index, 'M')
	assert.equal(f.staged, true)
	assert.equal(f.unstaged, false)
})

check('未暂存条目：staged 假 / unstaged 真', () => {
	const f = parseStatus(SAMPLE).files[1]
	assert.equal(f.path, 'src/b.js')
	assert.equal(f.worktree, 'M')
	assert.equal(f.staged, false)
	assert.equal(f.unstaged, true)
})

check('重命名条目带出原路径', () => {
	const f = parseStatus(SAMPLE).files[2]
	assert.equal(f.path, 'src/new.js')
	assert.equal(f.origPath, 'src/old.js')
})

check('未跟踪条目', () => {
	const f = parseStatus(SAMPLE).files[3]
	assert.equal(f.path, 'untracked.txt')
	assert.equal(f.untracked, true)
	assert.equal(f.staged, false)
	assert.equal(f.unstaged, true)
})

check('游离头标记为 detached 且无分支名', () => {
	const s = parseStatus('# branch.oid deadbeef\0# branch.head (detached)\0')
	assert.equal(s.detached, true)
	assert.equal(s.branch, null)
})

check('尚无提交时 head 为 null 且不算游离', () => {
	const s = parseStatus('# branch.oid (initial)\0# branch.head main\0')
	assert.equal(s.head, null)
	assert.equal(s.detached, false)
	assert.equal(s.branch, 'main')
})

// 未解决冲突（porcelain v2 的 `u` 记录）。实测形状：
//   u UU N... 100644 100644 100644 100644 <h1> <h2> <h3> <path>
const CONFLICT_SAMPLE = [
	'# branch.head main',
	'1 M. N... 100644 100644 100644 aaa bbb staged.js',
	'1 .M N... 100644 100644 100644 aaa bbb modified.js',
	'? fresh.txt',
	'u UU N... 100644 100644 100644 100644 h1 h2 h3 both.js'
].join('\0') + '\0'

check('conflictPaths 只挑未解决条目', () => {
	assert.deepEqual(conflictPaths(parseStatus(CONFLICT_SAMPLE)), ['both.js'])
})

check('没有冲突时 conflictPaths 为空（批量操作才放行）', () => {
	assert.deepEqual(conflictPaths(parseStatus(SAMPLE)), [])
})

// `git ls-files -u -- <path>` 的真实形态：<mode> <sha> <stage>\t<path>
// stage 1 = 共同祖先，2 = 本分支，3 = 对方。四种冲突的 stage 组合各不相同。
const LS_UU = '100644 2d78854 1\tsrc/app.js\n100644 3acb198 2\tsrc/app.js\n100644 84f94d5 3\tsrc/app.js\n'
const LS_AA = '100644 08e4756 2\tnotes/shared.md\n100644 afa6900 3\tnotes/shared.md\n'
const LS_UD = '100644 07e18ef 1\tsrc/config.json\n100644 c6f47ac 2\tsrc/config.json\n'
const LS_DU = '100644 07e18ef 1\tsrc/config.json\n100644 c6f47ac 3\tsrc/config.json\n'

check('conflictShape 从 stage 组合认出四种冲突', () => {
	assert.equal(conflictShape(LS_UU), 'UU')
	assert.equal(conflictShape(LS_AA), 'AA')
	assert.equal(conflictShape(LS_UD), 'UD')
	assert.equal(conflictShape(LS_DU), 'DU')
	assert.equal(conflictShape(''), null, '没有未合并条目时应为 null')
	assert.equal(conflictShape('100644 2d78854 1\tsrc/app.js\n'), null, '只有共同祖先不是冲突')
})

check('conflictDiffNote 对 modify/delete 说清两条出路（git 给不出 diff）', () => {
	// 实测 UD / DU 的 `git diff`（工作区与 --cached）都只回 "* Unmerged path"，
	// 所以这种冲突必须由宿主补一段说明，否则面板里就是一片空白。
	const note = conflictDiffNote('src/config.json', 'UD')
	assert.match(note, /modify\/delete/)
	assert.match(note, /UD = 本分支修改、对方删除/)
	assert.match(note, /git add src\/config\.json/)
	assert.match(note, /git rm src\/config\.json/)
	assert.match(conflictDiffNote('x.txt', 'DU'), /DU = 本分支删除、对方修改/)
	assert.match(conflictDiffNote('x.txt', null), /冲突尚未解决/)
})

check('isUnmergedPath 只看指定路径（批量闸门不能连坐无关文件）', () => {
	const s = parseStatus(CONFLICT_SAMPLE)
	assert.equal(isUnmergedPath('both.js', s), true)
	assert.equal(isUnmergedPath('modified.js', s), false, '普通改动文件不该被判成冲突')
	assert.equal(isUnmergedPath('nope.txt', s), false)
})

check('解析器把冲突条目判成 staged（所以客户端分组必须显式排除 unmerged）', () => {
	// `u UU` 的 XY 是 'UU'，makeFile 里 `staged = x !== '.'` 于是为 true ——
	// 冲突文件因此**同时**满足 staged 与 unstaged。客户端据此在三个分组的 filter 里
	// 显式排除 unmerged，让冲突单独成一组；这条用例钉住的是解析器这个事实本身，
	// 免得以后有人「顺手」去掉客户端那两处 `!f.unmerged` 而没人发现。
	// 「冲突文件到底显示在哪一组」不再靠口头记忆。
	const f = parseStatus(CONFLICT_SAMPLE).files.filter((x) => x.unmerged)[0]
	assert.equal(f.index, 'U')
	assert.equal(f.staged, true)
	assert.equal(f.unstaged, true)
})

check('无上游时 behind/ahead 为 0', () => {
	const s = parseStatus('# branch.head feature\0')
	assert.equal(s.upstream, null)
	assert.equal(s.ahead, 0)
	assert.equal(s.behind, 0)
})

// ── normalizeConfig ────────────────────────────────────────────
check('normalizeConfig 默认值', () => {
	const c = normalizeConfig()
	assert.equal(c.pullMode, 'ff-only')
	assert.equal(c.confirmTtlMs, 120000)
	assert.equal(c.commitPrompt, '')
})

check('normalizeConfig 覆盖并拒绝非法 pullMode', () => {
	assert.equal(normalizeConfig({ pullMode: 'merge' }).pullMode, 'merge')
	assert.equal(normalizeConfig({ pullMode: 'nonsense' }).pullMode, 'ff-only')
	assert.equal(normalizeConfig({ confirmTtlMs: 5000 }).confirmTtlMs, 5000)
})

// ── parseLog ───────────────────────────────────────────────────
const US = '\u001f'
const logLine = (sha, short, author, date, refs, subject) =>
	[sha, short, author, date, refs, subject].join(US)
const LOG_SAMPLE = [
	logLine('aaa1', 'aaa1', 'Alice', '2026-09-20T10:00:00+08:00', 'HEAD -> main, tag: v1', 'feat: 加分隔条'),
	logLine('bbb2', 'bbb2', 'Bob', '2026-09-19T09:00:00+08:00', '', 'fix: 修 clamp'),
	logLine('ccc3', 'ccc3', 'Cara', '2026-09-18T08:00:00+08:00', 'origin/main', 'chore: 清理')
].join('\n') + '\n'

check('parseLog 解析字段与 refs', () => {
	const r = parseLog(LOG_SAMPLE, 10)
	assert.equal(r.commits.length, 3)
	assert.equal(r.hasMore, false)
	const c = r.commits[0]
	assert.equal(c.sha, 'aaa1')
	assert.equal(c.short, 'aaa1')
	assert.equal(c.author, 'Alice')
	assert.equal(c.date, '2026-09-20T10:00:00+08:00')
	assert.deepEqual(c.refs, ['HEAD -> main', 'tag: v1'])
	assert.equal(c.subject, 'feat: 加分隔条')
})

check('parseLog 无 refs 时给空数组而不是空字符串', () => {
	assert.deepEqual(parseLog(LOG_SAMPLE, 10).commits[1].refs, [])
})

check('parseLog 多取一条时截断并标记 hasMore', () => {
	// 调用方按 limit+1 取，parseLog 负责裁掉多余那条并报 hasMore
	const r = parseLog(LOG_SAMPLE, 2)
	assert.equal(r.commits.length, 2)
	assert.equal(r.hasMore, true)
	assert.equal(r.commits[1].sha, 'bbb2')
})

check('parseLog 提交信息含分隔符也不截断', () => {
	const evil = logLine('d1', 'd1', 'Dan', '2026-09-17T00:00:00Z', '', `weird${US}subject`)
	const r = parseLog(evil, 10)
	assert.equal(r.commits[0].subject, `weird${US}subject`)
})

check('parseLog 空仓库输出返回空列表', () => {
	const r = parseLog('', 10)
	assert.deepEqual(r.commits, [])
	assert.equal(r.hasMore, false)
})

// ── mergeCommitFiles ───────────────────────────────────────────
check('mergeCommitFiles 合并状态与增删行数', () => {
	const files = mergeCommitFiles(
		'M\tsrc/a.ts\nA\tnew.ts\nD\told.ts',
		'3\t1\tsrc/a.ts\n5\t0\tnew.ts\n0\t7\told.ts'
	)
	const byPath = Object.fromEntries(files.map((f) => [f.path, f]))
	assert.equal(files.length, 3)
	assert.deepEqual(
		[byPath['src/a.ts'].status, byPath['src/a.ts'].additions, byPath['src/a.ts'].deletions],
		['M', 3, 1]
	)
	assert.equal(byPath['new.ts'].status, 'A')
	assert.equal(byPath['old.ts'].status, 'D')
})

check('mergeCommitFiles 重命名取第三列作为新路径', () => {
	// name-status 对重命名是 `R100\told\tnew` 三列 —— 取 parts[1] 会得到旧路径
	const files = mergeCommitFiles('R100\tsrc/old.ts\tsrc/new.ts', '2\t2\tsrc/new.ts')
	assert.equal(files.length, 1)
	assert.equal(files[0].path, 'src/new.ts')
	assert.equal(files[0].oldPath, 'src/old.ts')
	assert.equal(files[0].status, 'R')
})

check('mergeCommitFiles 二进制文件记为 null 而不是 0', () => {
	const files = mergeCommitFiles('M\tlogo.png', '-\t-\tlogo.png')
	assert.equal(files[0].additions, null)
	assert.equal(files[0].deletions, null)
})

check('mergeCommitFiles 未匹配到状态的 numstat 行被忽略', () => {
	const files = mergeCommitFiles('M\tsrc/a.ts', '1\t1\tsrc/a.ts\n9\t9\tghost.ts')
	assert.equal(files.length, 1)
	assert.equal(files[0].path, 'src/a.ts')
})

check('mergeCommitFiles 空输入返回空数组', () => {
	assert.deepEqual(mergeCommitFiles('', ''), [])
})

// ── resolveRepo 拒绝面 ─────────────────────────────────────────
// 鉴权是这台插件的安全核心，这里验证它确实会拒绝而不是静默放行。
function fakeCtx(overrides) {
	return Object.assign(
		{
			sessions: { get: () => undefined },
			// list() 是包含关系回退路径要用的；给空实现，避免 TypeError 掩盖真实断言。
			workspaceRegistry: { resolveByPath: async () => undefined, list: () => [] }
		},
		overrides
	)
}

const rejects = async (label, ctx, sessionId, code, clientCwd) => {
	await assert.rejects(
		() => resolveRepo(ctx, sessionId, clientCwd),
		(err) => err.code === code,
		`${label}: 期望 code=${code}`
	)
	passed += 1
	console.log(`  ✓ ${label}`)
}

await rejects('缺 sessionId 被拒', fakeCtx(), '', 'bad-request')
await rejects('未知 sessionId 被拒', fakeCtx(), 'nope', 'session-unknown')
await rejects(
	'会话无 header.cwd 且无 clientCwd 时被拒',
	fakeCtx({ sessions: { get: () => ({ header: {} }) } }),
	's1',
	'no-workspace'
)
await rejects(
	'cwd 不属于任何已注册工作区被拒',
	fakeCtx({
		sessions: { get: () => ({ header: { cwd: '/tmp' } }) },
		workspaceRegistry: { resolveByPath: async () => undefined, list: () => [] }
	}),
	's1',
	'workspace-unknown'
)
await rejects(
	'clientCwd 不属于任何已注册工作区时同样被拒（兜底不是后门）',
	fakeCtx({
		sessions: { get: () => ({ header: {} }) },
		workspaceRegistry: { resolveByPath: async () => undefined, list: () => [] }
	}),
	's1',
	'workspace-unknown',
	'/tmp'
)

// 回归：曾经读的是 session.cwd（Session 类没有这个顶层属性），导致永远是
// no-workspace。正确来源是 session.header.cwd。这里用 /tmp（存在但不是 git 仓库）
// 证明 header.cwd 确实被读到了 —— 它会走到 git 那一步并以 not-a-repo 失败，
// 而不是在 cwd 检查处就断掉。
await rejects(
	'回归：session.header.cwd 被读取（走到 git 检查而非 no-workspace）',
	fakeCtx({
		sessions: { get: () => ({ header: { cwd: '/tmp' } }) },
		workspaceRegistry: { resolveByPath: async () => ({ path: '/tmp' }), list: () => [] }
	}),
	's1',
	'not-a-repo'
)
await rejects(
	'header 缺 cwd 时 clientCwd 兜底生效（同样走到 git 检查）',
	fakeCtx({
		sessions: { get: () => ({ header: {} }) },
		workspaceRegistry: { resolveByPath: async () => ({ path: '/tmp' }), list: () => [] }
	}),
	's1',
	'not-a-repo',
	'/tmp'
)

// ── 包含关系回退（集成：用本仓库自己当真实 git 仓库）──────────────
// workspaceRegistry.resolveByPath() 是**精确相等**匹配，cwd 落在工作区子目录时
// 会返回 undefined。这条回归用本插件仓库当工作区、用它的 lib/ 子目录当会话 cwd，
// 断言 resolveRepo 仍能解析出仓库根。
{
	const repoRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
	const subdir = join(repoRoot, 'lib')
	const ctx = {
		sessions: { get: () => ({ header: { cwd: subdir } }) },
		workspaceRegistry: {
			resolveByPath: async () => undefined, // 模拟精确匹配漏掉子目录
			list: () => [{ path: repoRoot }]
		}
	}
	const repo = await resolveRepo(ctx, 's1')
	assert.equal(repo.root, repoRoot)
	passed += 1
	console.log('  ✓ 包含关系回退：cwd 是工作区子目录时仍解析出仓库根')
}

{
	// 反向：工作区不含该 cwd 时不能借回退蒙混过关。
	await rejects(
		'包含关系回退不放宽边界：cwd 在工作区之外仍被拒',
		{
			sessions: { get: () => ({ header: { cwd: '/tmp' } }) },
			workspaceRegistry: {
				resolveByPath: async () => undefined,
				list: () => [{ path: realpathSync(fileURLToPath(new URL('..', import.meta.url))) }]
			}
		},
		's1',
		'workspace-unknown'
	)
}

// ── 插件装配形状 ───────────────────────────────────────────────
check('name / inject 契约', () => {
	assert.equal(name, 'git-lite')
	assert.deepEqual(inject, ['webServer', 'sessions', 'workspaceRegistry'])
})

check('apply 注册 /git-lite 前缀路由且 llm 为可选注入', () => {
	const registered = []
	const injected = []
	const ctx = {
		webServer: {
			register: (opts) => {
				registered.push(opts)
				return () => {}
			}
		},
		inject: (deps) => {
			injected.push(deps)
			return () => {}
		},
		effect: (fn) => fn()
	}
	apply(ctx, {})
	assert.equal(registered.length, 1)
	assert.equal(registered[0].kind, 'prefix')
	assert.equal(registered[0].path, '/git-lite')
	assert.equal(typeof registered[0].handler, 'function')
	assert.deepEqual(injected[0], ['llm', 'agentDefaultModel'])
})

check('路由处理器对未知路径返回 404 且拒绝非 POST', async () => {
	const registered = []
	const ctx = {
		webServer: {
			register: (opts) => {
				registered.push(opts)
				return () => {}
			}
		},
		inject: () => () => {},
		effect: (fn) => fn()
	}
	apply(ctx, {})
	const handler = registered[0].handler

	const statuses = []
	const bodies = []
	const fakeRes = () => ({
		writeHead: (status) => statuses.push(status),
		end: (body) => bodies.push(body)
	})

	await handler({ method: 'GET', url: '/git-lite/status', on: () => {} }, fakeRes())
	assert.equal(statuses[0], 405)

	await handler({ method: 'POST', url: '/git-lite/nope', on: () => {} }, fakeRes())
	assert.equal(statuses[1], 404)
	assert.match(bodies[1], /unknown route/)
})

// 两条新的批量路由必须真的装配上，而不是悄悄 404。
// 用一个不存在的 sessionId 打进去：能落到宿主鉴权闸门（session-unknown）
// 就说明路由存在且 withRepo 包装生效。（真实 git 行为不在冒烟测试里跑。）
await acheck('新增的批量路由已装配（假 sessionId 得到 session-unknown，而不是 404）', async () => {
	const registered = []
	const ctx = {
		webServer: {
			register: (opts) => {
				registered.push(opts)
				return () => {}
			}
		},
		// 路由要过 resolveRepo 的第一道闸门，所以这里必须有 sessions。
		sessions: { get: () => undefined },
		inject: () => () => {},
		effect: (fn) => fn()
	}
	apply(ctx, {})
	const handler = registered[0].handler

	async function post(path) {
		const statuses = []
		const bodies = []
		const listeners = {}
		const req = {
			method: 'POST',
			url: path,
			on: (ev, cb) => {
				listeners[ev] = cb
				return req
			},
			destroy: () => {}
		}
		const done = handler(req, {
			writeHead: (s) => statuses.push(s),
			end: (b) => bodies.push(b)
		})
		listeners.data(Buffer.from(JSON.stringify({ sessionId: 'ghost' })))
		listeners.end()
		await done
		return { status: statuses[0], body: JSON.parse(bodies[0]) }
	}

	for (const path of ['/git-lite/stage-all', '/git-lite/unstage-all']) {
		const r = await post(path)
		assert.notEqual(r.status, 404, path + ' 未被装配（404）')
		assert.equal(r.body.ok, false, path)
		assert.equal(r.body.error.code, 'session-unknown', path + ' 应落到鉴权闸门')
	}
})

// ── LLM 调用契约 ───────────────────────────────────────────────
// 真实故障：本插件曾把 messages 写成 [{ role: 'user', content: '<裸字符串>' }]，
// 适配器 serializeMessages 会对 content 调 .filter() → 直接抛错；runtime 把该失败
// 包成终止 finish 分片，而消费方当时只挑 text-delta，于是失败被吞成空字符串，
// UI 上只剩一句误导人的「模型没有返回提交信息」。两条都要钉住。

check('buildUserMessage 的 content 是块数组（不是裸字符串）', () => {
	assert.deepEqual(buildUserMessage('hello').content, [{ type: 'text', text: 'hello' }])
})

check('buildUserMessage 带唯一 id 与 plugin source', () => {
	const a = buildUserMessage('x')
	const b = buildUserMessage('x')
	assert.equal(a.role, 'user')
	assert.ok(typeof a.id === 'string' && a.id.length > 0, 'id 不能为空')
	assert.notEqual(a.id, b.id, '每条消息的 id 必须唯一')
	assert.equal(a.source.kind, 'plugin')
	assert.equal(a.source.plugin, 'dsh-git-lite')
})

/** 造一个假的 llm.stream 分片序列。 */
async function* fakeStream(...chunks) {
	for (const chunk of chunks) yield chunk
}

await acheck('streamToText 累加 text-delta 并忽略无关分片', async () => {
	const text = await streamToText(
		fakeStream(
			{ type: 'block-start', index: 0 },
			{ type: 'text-delta', text: 'feat: ' },
			{ type: 'text-delta', text: 'add a thing' },
			{ type: 'usage', usage: { inputTokens: 1 } },
			{ type: 'finish', reason: { kind: 'stop' } }
		)
	)
	assert.equal(text, 'feat: add a thing')
})

await acheck('streamToText 空流返回空串（交由上层判定）', async () => {
	assert.equal(await streamToText(fakeStream()), '')
})

await acheck('streamToText 把 finish 的 error 抛出（保留提供方的 code / message）', async () => {
	await assert.rejects(
		streamToText(
			fakeStream({
				type: 'finish',
				reason: {
					kind: 'error',
					failure: {
						code: 'EMPTY_RESPONSE',
						message: 'model returned a completed response with no content'
					}
				}
			})
		),
		(err) => {
			assert.equal(err.code, 'EMPTY_RESPONSE')
			assert.equal(err.message, 'model returned a completed response with no content')
			return true
		}
	)
})

await acheck('streamToText 把 finish 的 aborted 抛出，缺字段时有兜底', async () => {
	await assert.rejects(
		streamToText(fakeStream({ type: 'finish', reason: { kind: 'aborted' } })),
		(err) => {
			assert.equal(err.code, 'llm-aborted')
			assert.match(err.message, /取消/)
			return true
		}
	)
})

console.log(`\n${passed} 项通过`)
