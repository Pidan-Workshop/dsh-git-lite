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
	inject,
	mergeCommitFiles,
	name,
	normalizeConfig,
	parseLog,
	parseStatus,
	resolveRepo
} from '../lib/index.js'

let passed = 0
function check(label, fn) {
	fn()
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

console.log(`\n${passed} 项通过`)
