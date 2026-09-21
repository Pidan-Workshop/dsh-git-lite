/**
 * 宿主半区冒烟测试：不需要 DSH 运行时，只验证纯函数与插件装配形状。
 *   node tests/host-smoke.mjs
 */
import assert from 'node:assert/strict'
import { apply, inject, name, normalizeConfig, parseStatus, resolveRepo } from '../lib/index.js'

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

// ── resolveRepo 拒绝面 ─────────────────────────────────────────
// 鉴权是这台插件的安全核心，这里验证它确实会拒绝而不是静默放行。
function fakeCtx(overrides) {
	return Object.assign(
		{
			sessions: { get: () => undefined },
			workspaceRegistry: { resolveByPath: async () => undefined }
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
		workspaceRegistry: { resolveByPath: async () => undefined }
	}),
	's1',
	'workspace-unknown'
)
await rejects(
	'clientCwd 不属于任何已注册工作区时同样被拒（兜底不是后门）',
	fakeCtx({
		sessions: { get: () => ({ header: {} }) },
		workspaceRegistry: { resolveByPath: async () => undefined }
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
		workspaceRegistry: { resolveByPath: async () => ({ path: '/tmp' }) }
	}),
	's1',
	'not-a-repo'
)
await rejects(
	'header 缺 cwd 时 clientCwd 兜底生效（同样走到 git 检查）',
	fakeCtx({
		sessions: { get: () => ({ header: {} }) },
		workspaceRegistry: { resolveByPath: async () => ({ path: '/tmp' }) }
	}),
	's1',
	'not-a-repo',
	'/tmp'
)

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
