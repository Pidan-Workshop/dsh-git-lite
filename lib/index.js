/**
 * dsh-git-lite —— 宿主半区（Node）。
 *
 * 设计要点：
 *
 * 1. 客户端只发 sessionId，不发路径。工作目录由 ctx.sessions.get(id).cwd 在宿主侧
 *    解析，再用 ctx.workspaceRegistry.resolveByPath() 校验它确实属于一个已注册工作区，
 *    最后确认 git toplevel 仍落在该工作区内。这样"让宿主在任意目录跑 git"这条路
 *    从结构上就不存在，而不是靠过滤字符串。
 *
 * 2. push 走两阶段确认，而不是 ctx.approval。原因是 ApprovalService.request() 的契约
 *    明确要求一个打开的 agent 轮次（"an idle ask rejects"），而本插件的 push 是 UI
 *    触发的、没有 open turn。两阶段确认反而更严格：第一次请求返回将要推送的
 *    HEAD sha / 分支 / 上游 / ahead 数 / commit 列表 + 一次性短期 token；确认时校验
 *    token 未用过、未过期、且 HEAD 与分支仍与预览时一致（防 TOCTOU）。
 *
 * 3. force push 在结构上不可能：argv 由本文件内部构造，客户端无法注入参数；
 *    另外 assertNoForce() 再做一层断言。
 *
 * 4. 所有 git 调用都带 GIT_TERMINAL_PROMPT=0，避免缺凭据时在无终端的 web 进程里挂死。
 *
 * 5. apply(ctx, config)；config 全部可选，默认值见 normalizeConfig()。
 */
import { execFile } from 'node:child_process'
import { realpath, readFile } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'

/** 稳定插件名（与 cordis.patch.yml 的行 id 一致）。 */
export const name = 'git-lite'

/** 宿主服务依赖。 */
export const inject = ['webServer', 'sessions', 'workspaceRegistry']

const API = '/git-lite'
const GIT_MAX_BUFFER = 8 * 1024 * 1024
const DIFF_MAX_BUFFER = 4 * 1024 * 1024
const UNTRACKED_MAX_LINES = 2000

// ────────────────────────────── 错误 ──────────────────────────────

class GitLiteError extends Error {
	constructor(code, message) {
		super(message)
		this.code = code
	}
}

function fail(code, message) {
	throw new GitLiteError(code, message)
}

// ────────────────────────────── 配置 ──────────────────────────────

export function normalizeConfig(config) {
	const c = config ?? {}
	return {
		/** 'ff-only'（默认，分叉即失败并如实报告）| 'merge' */
		pullMode: c.pullMode === 'merge' ? 'merge' : 'ff-only',
		/** diff 返回给浏览器的字节上限，超出则截断并标记。 */
		maxDiffBytes: Number.isFinite(c.maxDiffBytes) ? c.maxDiffBytes : 256 * 1024,
		/** push 确认 token 的有效期。 */
		confirmTtlMs: Number.isFinite(c.confirmTtlMs) ? c.confirmTtlMs : 120000,
		/** 覆盖「交给 Agent 提交」时注入的指令文本。 */
		commitPrompt: typeof c.commitPrompt === 'string' ? c.commitPrompt : '',
		/** 覆盖 AI 生成提交信息时使用的 system prompt。 */
		messagePrompt: typeof c.messagePrompt === 'string' ? c.messagePrompt : ''
	}
}

// ────────────────────────────── git 执行 ──────────────────────────────

/**
 * 执行 git。argv 必须是数组，绝不由客户端拼接。
 * @returns {Promise<{ok: boolean, code: number|string, stdout: string, stderr: string}>}
 */
function runGit(args, cwd, options = {}) {
	return new Promise((resolve) => {
		execFile(
			'git',
			args,
			{
				cwd,
				maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER,
				windowsHide: true,
				env: {
					...process.env,
					// 无终端的 web 进程里，缺凭据必须立刻失败，不能等输入。
					GIT_TERMINAL_PROMPT: '0',
					GIT_PAGER: 'cat',
					GIT_OPTIONAL_LOCKS: '0',
					// 让路径按原样输出，便于与 status 的 path 逐字匹配。
					LC_ALL: 'C'
				}
			},
			(error, stdout, stderr) => {
				resolve({
					ok: error === null,
					code: error === null ? 0 : (error.code ?? 'unknown'),
					stdout: String(stdout ?? ''),
					stderr: String(stderr ?? '')
				})
			}
		)
	})
}

/** 执行 git 并要求成功，失败时抛出可读错误。 */
async function mustGit(args, cwd, options) {
	const r = await runGit(args, cwd, options)
	if (!r.ok) {
		const detail = (r.stderr || r.stdout || '').trim() || `git ${args[0]} exited with ${r.code}`
		fail('git-failed', detail)
	}
	return r.stdout
}

const FORCE_FLAGS = /^(-f|--force|--force-with-lease|--force-if-includes)(=.*)?$/

/** 纵深防御：push 的 argv 由内部构造，这里再断言一次绝不含 force。 */
function assertNoForce(args) {
	for (const a of args) {
		if (FORCE_FLAGS.test(a)) fail('force-forbidden', 'dsh-git-lite 拒绝一切 force push')
	}
}

// ────────────────────────────── 会话 → 仓库 鉴权 ──────────────────────────────

/** child 是否在 parent 之内（含相等）。 */
function isWithin(parent, child) {
	if (parent === child) return true
	const rel = relative(parent, child)
	return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 找出「包含」该目录的已注册工作区。
 *
 * 为什么不直接用 workspaceRegistry.resolveByPath()：它的实现是**精确相等**匹配
 * （`for (...) if (entity.path === canonical) return entity`），契约也写明
 * "an existing unowned directory returns undefined"。于是会话 cwd 落在工作区的
 * *子目录* 时会返回 undefined —— 而 cwd 是子目录是很常见的（在仓库子目录里开的会话）。
 * 这里改为包含关系，并取最长（最具体）的那个根。
 *
 * 边界没有被放宽：能被选中的仍然只是已注册工作区的子树；而且仓库根还要再过一次
 * 同样的包含校验（第 3 道闸门），所以越界依旧不可能。
 */
async function findOwningWorkspace(ctx, canonicalCwd) {
	const exact = await ctx.workspaceRegistry.resolveByPath(canonicalCwd)
	if (exact !== undefined) return exact

	let best
	let bestLength = -1
	for (const workspace of ctx.workspaceRegistry.list()) {
		let root
		try {
			root = await realpath(workspace.path)
		} catch {
			continue // 登记的工作区已不在磁盘上
		}
		if (!isWithin(root, canonicalCwd)) continue
		if (root.length > bestLength) {
			best = workspace
			bestLength = root.length
		}
	}
	return best
}

/**
 * 由 sessionId 解析出可安全操作的 git 仓库根。
 *
 * 三道校验，任何一道不过就拒绝：
 *   1. sessionId 必须对应一个活着的会话，且能确定工作目录；
 *   2. cwd 必须落在某个已注册工作区**之内**（含相等）；
 *   3. `git rev-parse --show-toplevel` 得到的仓库根（realpath 后）仍必须落在该工作区内
 *      —— 这一步挡住「工作区是某个更大仓库的子目录」这种越界。
 *
 * 工作目录有两个来源，优先级明确：
 *   · 宿主权威值 `session.header.cwd`（Session 类**没有**顶层 cwd，创建元数据挂在 header 上）；
 *   · 宿主没有时，退回调用方上报的 clientCwd。
 * 退回值是安全的：它同样要过上面第 2、3 道闸门，所以最多只能指向另一个
 * *已注册工作区*，无法让宿主在任意目录跑 git。
 *
 * @param ctx - 宿主上下文
 * @param sessionId - 目标会话
 * @param clientCwd - 可选的调用方上报工作目录（仅在宿主无权威值时启用）
 * @returns {Promise<{root: string, cwd: string, sessionId: string}>}
 */
export async function resolveRepo(ctx, sessionId, clientCwd) {
	if (typeof sessionId !== 'string' || sessionId === '') {
		fail('bad-request', 'sessionId is required')
	}
	const session = ctx.sessions.get(sessionId)
	if (session === undefined) {
		fail('session-unknown', 'no live session with that id')
	}

	const hostCwd = session.header !== undefined ? session.header.cwd : undefined
	const cwd = typeof hostCwd === 'string' && hostCwd !== '' ? hostCwd : clientCwd
	if (typeof cwd !== 'string' || cwd === '') {
		fail('no-workspace', 'this session has no working directory')
	}

	let canonicalCwd
	try {
		canonicalCwd = await realpath(cwd)
	} catch {
		fail('no-workspace', `working directory does not resolve on disk: ${cwd}`)
	}

	const workspace = await findOwningWorkspace(ctx, canonicalCwd)
	if (workspace === undefined) {
		fail('workspace-unknown', 'working directory is not inside a registered workspace')
	}

	const top = await runGit(['rev-parse', '--show-toplevel'], canonicalCwd)
	if (!top.ok) {
		fail('not-a-repo', 'this workspace is not inside a git repository')
	}

	let root
	try {
		root = await realpath(top.stdout.trim())
	} catch {
		fail('not-a-repo', 'git reported a toplevel that does not resolve on disk')
	}

	let workspaceRoot = workspace.path
	try {
		workspaceRoot = await realpath(workspace.path)
	} catch {
		/* 保留原值；下面的 isWithin 会因不匹配而拒绝。 */
	}
	if (!isWithin(workspaceRoot, root)) {
		fail('outside-workspace', 'repository root is outside the registered workspace')
	}

	return { root, cwd: canonicalCwd, sessionId }
}

/** 拒绝绝对路径与 `..` 逃逸。git argv 里它只是一个独立参数，这里是语义防御。 */
function assertSafePath(p) {
	if (typeof p !== 'string' || p === '') fail('bad-request', 'path is required')
	if (isAbsolute(p)) fail('bad-path', 'absolute paths are not accepted')
	if (p.split(/[\\/]+/).includes('..')) fail('bad-path', 'path escapes the repository')
	return p
}

// ────────────────────────────── status 解析 ──────────────────────────────

function makeFile(path, xy, origPath, unmerged = false) {
	const untracked = xy === '??'
	const x = xy[0] ?? '.'
	const y = xy[1] ?? '.'
	return {
		path,
		origPath: origPath ?? null,
		index: x,
		worktree: y,
		staged: !untracked && x !== '.',
		unstaged: untracked || y !== '.',
		untracked,
		unmerged,
		additions: null,
		deletions: null
	}
}

/**
 * 解析 `git status --porcelain=v2 --branch -z`。
 * v2 + -z 是为了让重命名有独立的原路径记录，且路径不被引号包裹。
 */
export function parseStatus(stdout) {
	const tokens = stdout.split('\0')
	const out = {
		branch: null,
		upstream: null,
		head: null,
		ahead: 0,
		behind: 0,
		detached: false,
		files: []
	}

	for (let i = 0; i < tokens.length; i++) {
		const rec = tokens[i]
		if (rec === '') continue

		if (rec.startsWith('# branch.head ')) {
			const head = rec.slice(14)
			out.detached = head === '(detached)'
			out.branch = head === '(detached)' ? null : head
			continue
		}
		if (rec.startsWith('# branch.upstream ')) {
			out.upstream = rec.slice(18)
			continue
		}
		if (rec.startsWith('# branch.oid ')) {
			const oid = rec.slice(13)
			// '(initial)' 表示尚无提交，不是游离头；游离态由 branch.head 标记。
			out.head = oid === '(initial)' ? null : oid
			continue
		}
		if (rec.startsWith('# branch.ab ')) {
			const m = /^\+(\d+) -(\d+)$/.exec(rec.slice(12))
			if (m !== null) {
				out.ahead = Number(m[1])
				out.behind = Number(m[2])
			}
			continue
		}
		if (rec.startsWith('# ')) continue

		const kind = rec[0]
		if (kind === '1') {
			// 1 XY sub mH mI mW hH hI <path>
			const parts = rec.split(' ')
			out.files.push(makeFile(parts.slice(8).join(' '), parts[1]))
		} else if (kind === '2') {
			// 2 XY sub mH mI mW hH hI Xscore <path>\0<origPath>
			const parts = rec.split(' ')
			const origPath = tokens[i + 1]
			i += 1
			out.files.push(makeFile(parts.slice(9).join(' '), parts[1], origPath))
		} else if (kind === 'u') {
			// u XY sub m1 m2 m3 mW h1 h2 h3 <path>
			const parts = rec.split(' ')
			out.files.push(makeFile(parts.slice(10).join(' '), parts[1], null, true))
		} else if (kind === '?') {
			out.files.push(makeFile(rec.slice(2), '??'))
		}
		// '!'（ignored）忽略
	}

	return out
}

/** 把 `git diff --numstat` 的增删行数并进文件列表。 */
function applyNumstat(files, stdout) {
	if (stdout === '') return
	const byPath = new Map()
	for (const line of stdout.split('\n')) {
		if (line === '') continue
		const parts = line.split('\t')
		if (parts.length < 3) continue
		const [add, del, ...rest] = parts
		byPath.set(rest.join('\t'), {
			additions: add === '-' ? null : Number(add),
			deletions: del === '-' ? null : Number(del)
		})
	}
	for (const f of files) {
		const hit = byPath.get(f.path)
		if (hit !== undefined) {
			f.additions = hit.additions
			f.deletions = hit.deletions
			byPath.delete(f.path)
		}
	}
}

async function collectStatus(root) {
	const stdout = await mustGit(
		['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
		root
	)
	const status = parseStatus(stdout)

	const [unstaged, staged] = await Promise.all([
		runGit(['diff', '--numstat', '--no-color'], root),
		runGit(['diff', '--cached', '--numstat', '--no-color'], root)
	])
	if (staged.ok) applyNumstat(status.files.filter((f) => f.staged), staged.stdout)
	if (unstaged.ok) applyNumstat(status.files.filter((f) => f.unstaged && !f.untracked), unstaged.stdout)

	status.totalAdditions = status.files.reduce((n, f) => n + (f.additions ?? 0), 0)
	status.totalDeletions = status.files.reduce((n, f) => n + (f.deletions ?? 0), 0)
	return status
}

// ────────────────────────────── diff ──────────────────────────────

/** 为未跟踪文件合成一个 /dev/null → 新文件的 unified diff（跨平台，不依赖 /dev/null）。 */
async function synthUntrackedDiff(root, path, maxBytes) {
	let text
	try {
		text = await readFile(`${root}${sep}${path}`, 'utf8')
	} catch (e) {
		fail('git-failed', `cannot read untracked file: ${e?.message ?? e}`)
	}
	const lines = text.split('\n')
	if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
	const shown = lines.slice(0, UNTRACKED_MAX_LINES)
	const truncated = lines.length > shown.length
	const body = shown.map((l) => `+${l}`).join('\n')
	const header = [
		`diff --git a/${path} b/${path}`,
		'new file mode 100644',
		'--- /dev/null',
		`+++ b/${path}`,
		`@@ -0,0 +1,${shown.length} @@`
	].join('\n')
	return {
		diff: `${header}\n${body}\n`,
		truncated: truncated || Buffer.byteLength(`${header}\n${body}\n`, 'utf8') > maxBytes
	}
}

/**
 * 按字节上限截断 diff 文本。UTF-8 截断可能切裂多字节字符，浏览器端只做逐行着色，
 * 因此残留的半个字符只会出现在最后一行，可接受。
 * @returns {{diff: string, truncated: boolean}}
 */
function clipDiff(diff, maxBytes) {
	if (Buffer.byteLength(diff, 'utf8') > maxBytes) {
		return {
			diff: Buffer.from(diff, 'utf8').subarray(0, maxBytes).toString('utf8'),
			truncated: true
		}
	}
	return { diff, truncated: false }
}

async function collectDiff(root, path, staged, maxBytes) {
	let diff = ''
	let truncated = false

	if (staged) {
		diff = await mustGit(['diff', '--cached', '--no-color', '-U3', '--', path], root, {
			maxBuffer: DIFF_MAX_BUFFER
		})
	} else {
		// 先试工作区 diff（覆盖已跟踪文件的未暂存改动）
		const worktree = await runGit(['diff', '--no-color', '-U3', '--', path], root, {
			maxBuffer: DIFF_MAX_BUFFER
		})
		if (!worktree.ok) {
			fail('git-failed', (worktree.stderr || '').trim() || 'git diff failed')
		}
		if (worktree.stdout.trim() !== '') {
			diff = worktree.stdout
		} else {
			// 可能是未跟踪文件：确认后合成
			const tracked = await runGit(['ls-files', '--error-unmatch', '--', path], root)
			if (tracked.ok) {
				diff = '' // 已跟踪但无改动
			} else {
				const synth = await synthUntrackedDiff(root, path, maxBytes)
				return synth
			}
		}
	}

	return clipDiff(diff, maxBytes)
}

// ────────────────────────────── 提交历史 ──────────────────────────────

/**
 * `git log --format` 的字段分隔符用 ASCII 单元分隔符（0x1f），
 * 而不是制表符或 `|` —— 提交信息里出现这些字符的概率不为零。
 * subject 放在**最后**，即使它含有分隔符也只影响自身的拼接结果。
 */
const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%aI%x1f%D%x1f%s'
const US = '\u001f'

/**
 * 解析 `git log` 输出。
 *
 * @param stdout - git log 的原始输出
 * @param limit - 期望条数；调用方应多取一条用于判断是否还有更多
 * @returns {{commits: Array<object>, hasMore: boolean}}
 */
export function parseLog(stdout, limit) {
	const commits = stdout
		.split('\n')
		.filter((line) => line !== '')
		.map((line) => {
			const f = line.split(US)
			const refsRaw = f[4] ?? ''
			return {
				sha: f[0] ?? '',
				short: f[1] ?? '',
				author: f[2] ?? '',
				date: f[3] ?? '',
				refs: refsRaw === ''
					? []
					: refsRaw
							.split(',')
							.map((r) => r.trim())
							.filter((r) => r !== ''),
				// subject 可能含分隔符，用 slice 拼回而不是取单个下标
				subject: f.slice(5).join(US)
			}
		})
	const hasMore = commits.length > limit
	return { commits: hasMore ? commits.slice(0, limit) : commits, hasMore }
}

/**
 * 合并 `git show --name-status` 与 `--numstat` 的输出，得到每条提交的文件清单。
 *
 * 两次调用而不是一次：name-status 给状态字母（A/M/D/R），numstat 给增删行数，
 * 两者都不单独提供对方的完整信息。合并键是**路径**，而重命名在 name-status 里
 * 占三列（`R100	old	new`），必须取 `parts[2]`，这是最容易写错的一处。
 *
 * @returns {Array<{path: string, status: string, oldPath: string|null, additions: number|null, deletions: number|null}>}
 */
export function mergeCommitFiles(nameStatusOut, numstatOut) {
	const byPath = new Map()

	for (const line of nameStatusOut.split('\n')) {
		if (line === '') continue
		const parts = line.split('\t')
		const code = parts[0] ?? ''
		const renamed = code.startsWith('R') || code.startsWith('C')
		const path = renamed ? parts[2] : parts[1]
		if (path === undefined || path === '') continue
		byPath.set(path, {
			path,
			status: code.charAt(0),
			oldPath: renamed ? (parts[1] ?? null) : null,
			additions: null,
			deletions: null
		})
	}

	for (const line of numstatOut.split('\n')) {
		if (line === '') continue
		const parts = line.split('\t')
		if (parts.length < 3) continue
		const path = parts.slice(2).join('\t')
		const hit = byPath.get(path)
		if (hit === undefined) continue
		// 二进制文件 git 报 `-`，如实记为 null 而不是 0
		hit.additions = parts[0] === '-' ? null : Number(parts[0])
		hit.deletions = parts[1] === '-' ? null : Number(parts[1])
	}

	return [...byPath.values()]
}

/** 校验提交 sha。它作为独立 argv 传入，这里同时挡掉以 `-` 开头的伪参数。 */
function assertSafeSha(sha) {
	if (typeof sha !== 'string' || !/^[0-9a-fA-F]{4,40}$/.test(sha)) {
		fail('bad-request', 'invalid commit sha')
	}
	return sha
}

// ────────────────────────────── push 两阶段确认 ──────────────────────────────

/** 一次性 push 确认 token 存储。 */
function createConfirmStore(ttlMs) {
	const pending = new Map()

	function sweep() {
		const now = Date.now()
		for (const [token, entry] of pending) {
			if (entry.expiresAt <= now) pending.delete(token)
		}
	}

	return {
		issue(payload) {
			sweep()
			const token = `gl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`
			pending.set(token, { ...payload, expiresAt: Date.now() + ttlMs })
			return token
		},
		/** 取出并立即作废（单次使用）。 */
		consume(token) {
			sweep()
			const entry = pending.get(token)
			if (entry === undefined) return undefined
			pending.delete(token)
			return entry
		},
		get size() {
			return pending.size
		}
	}
}

async function pushPreview(ctx, repo, store) {
	const status = await collectStatus(repo.root)
	if (status.detached) fail('detached-head', 'HEAD 处于游离状态，无法推送（请先切到分支）')
	if (status.branch === null) fail('no-branch', '无法确定当前分支')
	if (status.upstream === null) {
		fail('no-upstream', `分支 ${status.branch} 没有上游，请先在终端执行 git push -u origin ${status.branch}`)
	}
	if (status.ahead === 0) fail('nothing-to-push', '没有待推送的提交')

	const log = await mustGit(
		['log', '--oneline', '--no-color', `${status.upstream}..HEAD`],
		repo.root
	)
	const commits = log
		.split('\n')
		.filter((l) => l !== '')
		.map((l) => {
			const sp = l.indexOf(' ')
			return { sha: l.slice(0, sp), subject: l.slice(sp + 1) }
		})

	const head = (await mustGit(['rev-parse', 'HEAD'], repo.root)).trim()
	const token = store.issue({
		sessionId: repo.sessionId,
		root: repo.root,
		branch: status.branch,
		upstream: status.upstream,
		head
	})

	return {
		token,
		branch: status.branch,
		upstream: status.upstream,
		head: head.slice(0, 12),
		ahead: status.ahead,
		behind: status.behind,
		commits
	}
}

async function pushConfirm(ctx, repo, store, token) {
	const entry = store.consume(token)
	if (entry === undefined) {
		fail('confirm-expired', '确认已过期或已被使用，请重新点击推送')
	}
	if (entry.sessionId !== repo.sessionId || entry.root !== repo.root) {
		fail('confirm-mismatch', '确认与实际仓库不匹配')
	}

	// TOCTOU：预览之后分支或 HEAD 变了就必须重来。
	const branch = (await mustGit(['rev-parse', '--abbrev-ref', 'HEAD'], repo.root)).trim()
	if (branch !== entry.branch) {
		fail('confirm-stale', `分支已从 ${entry.branch} 变为 ${branch}，请重新确认`)
	}
	const head = (await mustGit(['rev-parse', 'HEAD'], repo.root)).trim()
	if (head !== entry.head) {
		fail('confirm-stale', '预览之后 HEAD 已变化，请重新确认')
	}
	const upstream = (await mustGit(
		['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
		repo.root
	)).trim()
	if (upstream !== entry.upstream) {
		fail('confirm-stale', '上游已变化，请重新确认')
	}

	// 无参数 push：只推当前分支到其上游，不做任何 refspec 改写。
	const args = ['push']
	assertNoForce(args)
	const r = await runGit(args, repo.root)
	if (!r.ok) {
		fail('git-failed', (r.stderr || r.stdout || '').trim() || 'git push failed')
	}
	return { output: `${r.stderr}${r.stdout}`.trim(), branch, upstream }
}

// ────────────────────────────── AI 生成提交信息 ──────────────────────────────

const DEFAULT_MESSAGE_SYSTEM = [
	'You write git commit messages.',
	'Output ONLY the commit message — no code fences, no preamble, no explanation.',
	'First line: imperative subject, at most 72 characters, no trailing period.',
	'Then a blank line, then optional short bullet points explaining what changed and why.',
	'Write in the same language as the repository\'s recent commit messages when that is discoverable from the diff context; otherwise use English.'
].join('\n')

/** 收集 llm.stream 的文本增量。 */
async function streamToText(iterable) {
	let text = ''
	for await (const chunk of iterable) {
		if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
	}
	return text.trim()
}

async function generateCommitMessage(llmScope, repo, config) {
	if (llmScope === null) {
		fail('llm-unavailable', '当前 profile 没有可用的 llm 服务，无法生成提交信息')
	}

	let selection
	try {
		selection = llmScope.agentDefaultModel.currentSelection()
	} catch {
		fail('llm-unavailable', '无法解析默认模型，请先在设置中选定一个模型')
	}
	if (selection === undefined || selection === null) {
		fail('llm-unavailable', '尚未选择默认模型')
	}

	const status = await mustGit(
		['status', '--porcelain=v2', '--branch', '--untracked-files=all'],
		repo.root
	)
	const stagedDiff = await runGit(['diff', '--cached', '--no-color', '-U2'], repo.root, {
		maxBuffer: DIFF_MAX_BUFFER
	})
	const worktreeDiff = await runGit(['diff', '--no-color', '-U2'], repo.root, {
		maxBuffer: DIFF_MAX_BUFFER
	})
	// 仓库既有风格：最近 10 条 subject，供模型对齐语气与语言。
	const recent = await runGit(['log', '--no-color', '--pretty=format:%s', '-10'], repo.root)

	const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s)
	const user = [
		'<recent_commit_subjects>',
		clip(recent.stdout.trim(), 1200),
		'</recent_commit_subjects>',
		'',
		'<git_status>',
		clip(status.trim(), 4000),
		'</git_status>',
		'',
		'<staged_diff>',
		clip(stagedDiff.stdout, 24000),
		'</staged_diff>',
		'',
		'<worktree_diff>',
		clip(worktreeDiff.stdout, 24000),
		'</worktree_diff>'
	].join('\n')

	const text = await streamToText(
		llmScope.llm.stream({
			provider: selection.provider,
			model: selection.model,
			system: config.messagePrompt !== '' ? config.messagePrompt : DEFAULT_MESSAGE_SYSTEM,
			messages: [{ role: 'user', content: user }]
		})
	)

	const message = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim()
	if (message === '') fail('llm-empty', '模型没有返回提交信息')
	return message
}

// ────────────────────────────── HTTP 管道 ──────────────────────────────

function sendJson(res, body, status = 200) {
	const payload = JSON.stringify(body)
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(payload)
	})
	res.end(payload)
}

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let size = 0
		req.on('data', (c) => {
			size += c.length
			if (size > 256 * 1024) {
				reject(new GitLiteError('bad-request', 'request body too large'))
				req.destroy()
				return
			}
			chunks.push(c)
		})
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8')
			if (raw.trim() === '') return resolve({})
			try {
				const parsed = JSON.parse(raw)
				if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
					return reject(new GitLiteError('bad-request', 'body must be a JSON object'))
				}
				resolve(parsed)
			} catch {
				reject(new GitLiteError('bad-request', 'body is not valid JSON'))
			}
		})
		req.on('error', reject)
	})
}

/** 包装一个需要 sessionId 的处理器：解析仓库 + 统一错误映射。 */
function withRepo(ctx, handler) {
	return async (body) => {
		const repo = await resolveRepo(ctx, body.sessionId, body.cwd)
		return handler(repo, body)
	}
}

// ────────────────────────────── 路由表 ──────────────────────────────

function createRouter(ctx, config, llmRef) {
	const store = createConfirmStore(config.confirmTtlMs)

	const routes = {
		[`${API}/status`]: withRepo(ctx, async (repo) => {
			const status = await collectStatus(repo.root)
			return { root: repo.root, ...status }
		}),

		[`${API}/diff`]: withRepo(ctx, async (repo, body) => {
			const path = assertSafePath(body.path)
			return collectDiff(repo.root, path, body.staged === true, config.maxDiffBytes)
		}),

		[`${API}/branches`]: withRepo(ctx, async (repo) => {
			const local = await mustGit(
				['for-each-ref', '--format=%(refname:short)%09%(upstream:short)%09%(HEAD)', 'refs/heads'],
				repo.root
			)
			const remote = await runGit(
				['for-each-ref', '--format=%(refname:short)', 'refs/remotes'],
				repo.root
			)
			const parse = (out, isRemote) =>
				out
					.split('\n')
					.filter((l) => l !== '')
					.map((l) => {
						const [name, upstream, head] = l.split('\t')
						if (isRemote && name.endsWith('/HEAD')) return null
						return {
							name,
							upstream: upstream === '' ? null : upstream,
							current: head === '*'
						}
					})
					.filter((x) => x !== null)
			return {
				local: parse(local, false),
				remote: parse(remote.stdout, true)
			}
		}),

		[`${API}/fetch`]: withRepo(ctx, async (repo) => {
			const r = await runGit(['fetch', '--all', '--prune'], repo.root)
			if (!r.ok) fail('git-failed', (r.stderr || '').trim() || 'git fetch failed')
			return { output: `${r.stderr}${r.stdout}`.trim() }
		}),

		[`${API}/pull`]: withRepo(ctx, async (repo) => {
			const args = config.pullMode === 'merge' ? ['pull', '--no-edit'] : ['pull', '--ff-only']
			const r = await runGit(args, repo.root)
			if (!r.ok) {
				const detail = (r.stderr || r.stdout || '').trim()
				// 分叉情形给出可操作提示，而不是把 git 的英文原文直接丢给用户。
				if (/not possible to fast-forward|divergent|refusing to merge unrelated/i.test(detail)) {
					fail('pull-diverged', `本地与远端已分叉，--ff-only 拒绝合并。请在终端处理：git pull --rebase`)
				}
				fail('git-failed', detail || 'git pull failed')
			}
			return { output: `${r.stderr}${r.stdout}`.trim() }
		}),

		[`${API}/push/preview`]: withRepo(ctx, async (repo) => pushPreview(ctx, repo, store)),

		[`${API}/push/confirm`]: withRepo(ctx, async (repo, body) => {
			if (typeof body.token !== 'string' || body.token === '') {
				fail('bad-request', 'token is required')
			}
			return pushConfirm(ctx, repo, store, body.token)
		}),

		[`${API}/stage`]: withRepo(ctx, async (repo, body) => {
			const path = assertSafePath(body.path)
			await mustGit(['add', '--', path], repo.root)
			return { ok: true }
		}),

		[`${API}/unstage`]: withRepo(ctx, async (repo, body) => {
			const path = assertSafePath(body.path)
			// git restore --staged 在尚无提交的仓库里会失败，退回 git reset。
			const restored = await runGit(['restore', '--staged', '--', path], repo.root)
			if (!restored.ok) {
				await mustGit(['reset', '--quiet', '--', path], repo.root)
			}
			return { ok: true }
		}),

		[`${API}/commit`]: withRepo(ctx, async (repo, body) => {
			const message = typeof body.message === 'string' ? body.message.trim() : ''
			if (message === '') fail('bad-request', '提交信息不能为空')
			if (body.stageAll === true) {
				await mustGit(['add', '-A'], repo.root)
			}
			const staged = await mustGit(['diff', '--cached', '--name-only'], repo.root)
			if (staged.trim() === '') fail('nothing-staged', '暂存区为空，请先暂存要提交的文件')
			await mustGit(['commit', '-m', message], repo.root)
			const head = (await mustGit(['rev-parse', '--short', 'HEAD'], repo.root)).trim()
			return { head }
		}),

		[`${API}/stash`]: withRepo(ctx, async (repo, body) => {
			const action = body.action === 'pop' ? 'pop' : 'push'
			const args = action === 'pop' ? ['stash', 'pop'] : ['stash', 'push']
			if (action === 'push' && typeof body.message === 'string' && body.message.trim() !== '') {
				args.push('-m', body.message.trim())
			}
			const r = await runGit(args, repo.root)
			if (!r.ok) fail('git-failed', (r.stderr || r.stdout || '').trim() || `git stash ${action} failed`)
			return { output: `${r.stderr}${r.stdout}`.trim() }
		}),

		[`${API}/checkout`]: withRepo(ctx, async (repo, body) => {
			const branch = typeof body.branch === 'string' ? body.branch.trim() : ''
			if (branch === '') fail('bad-request', 'branch is required')
			// 以 '-' 开头的名字会被 git 当参数解析，直接拒绝。
			if (branch.startsWith('-')) fail('bad-branch', '非法分支名')
			const r = await runGit(['switch', branch], repo.root)
			if (!r.ok) {
				const detail = (r.stderr || r.stdout || '').trim()
				if (/local changes|would be overwritten/i.test(detail)) {
					fail('dirty-worktree', '工作区有未提交改动，会与目标分支冲突。请先提交或 stash。')
				}
				fail('git-failed', detail || 'git switch failed')
			}
			return { output: `${r.stderr}${r.stdout}`.trim() }
		}),

		[`${API}/log`]: withRepo(ctx, async (repo, body) => {
			const limit = Number.isFinite(body.limit)
				? Math.min(Math.max(1, Math.trunc(body.limit)), 200)
				: 50
			const skip = Number.isFinite(body.skip) ? Math.max(0, Math.trunc(body.skip)) : 0
			// 尚无任何提交时 git log 会失败：这是正常状态，如实返回空列表而不是报错。
			const head = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], repo.root)
			if (!head.ok) return { commits: [], hasMore: false }
			const out = await mustGit(
				[
					'log',
					'--no-color',
					`--format=${LOG_FORMAT}`,
					`-n${limit + 1}`, // 多取一条用于判断 hasMore
					`--skip=${skip}`
				],
				repo.root
			)
			return parseLog(out, limit)
		}),

		[`${API}/show`]: withRepo(ctx, async (repo, body) => {
			const sha = assertSafeSha(body.sha)
			if (body.path !== undefined) {
				const path = assertSafePath(body.path)
				const diff = await mustGit(['show', '--no-color', '-U3', sha, '--', path], repo.root, {
					maxBuffer: DIFF_MAX_BUFFER
				})
				return clipDiff(diff, config.maxDiffBytes)
			}
			// 打开整条提交：一次给出完整 patch + 文件清单，客户端下钻只需这一次往返。
			const diff = await mustGit(['show', '--no-color', '-U3', sha], repo.root, {
				maxBuffer: DIFF_MAX_BUFFER
			})
			const nameStatus = await mustGit(['show', '--name-status', '--format=', sha], repo.root)
			const numstat = await mustGit(['show', '--numstat', '--format=', sha], repo.root)
			return Object.assign(clipDiff(diff, config.maxDiffBytes), {
				files: mergeCommitFiles(nameStatus, numstat)
			})
		}),

		[`${API}/message`]: withRepo(ctx, async (repo) =>
			({ message: await generateCommitMessage(llmRef.current, repo, config) })
		)
	}

	return async (req, res) => {
		try {
			const url = new URL(req.url ?? '/', 'http://dsh')
			if (req.method !== 'POST') {
				sendJson(res, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } }, 405)
				return
			}
			const handler = routes[url.pathname]
			if (handler === undefined) {
				sendJson(res, { ok: false, error: { code: 'not-found', message: `unknown route ${url.pathname}` } }, 404)
				return
			}
			const body = await readJsonBody(req)
			const value = await handler(body)
			sendJson(res, { ok: true, value })
		} catch (error) {
			const code = error instanceof GitLiteError ? error.code : 'internal'
			const message = error instanceof Error ? error.message : String(error)
			sendJson(res, { ok: false, error: { code, message } }, code === 'internal' ? 500 : 200)
		}
	}
}

// ────────────────────────────── 插件入口 ──────────────────────────────

export function apply(ctx, rawConfig) {
	const config = normalizeConfig(rawConfig)

	// llm + agentDefaultModel 只在「AI 生成提交信息」这一个路由上用得到，
	// 因此走可选注入：缺了它们插件其余功能照常工作。
	const llmRef = { current: null }
	ctx.inject(['llm', 'agentDefaultModel'], (scope) => {
		llmRef.current = scope
		return () => {
			llmRef.current = null
		}
	})

	const handler = createRouter(ctx, config, llmRef)
	ctx.effect(
		() => ctx.webServer.register({ kind: 'prefix', path: API, handler }),
		'dsh-git-lite: /git-lite routes'
	)
}

export default { apply, inject, name }
