#!/usr/bin/env node
import { z } from 'zod'
import { Command } from 'commander'
import { chmod, lstat, mkdir, open, readFile, realpath, rename, stat, writeFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mergeSkill, newerVersion, personalDescription, skillDescription, skillHash, tailCount, tailTitle, tailTitles, tailTopics } from './skill-files.js'
import * as text from './render.js'
import { printable } from './render.js'

const { version } = z.object({ version: z.string() }).parse(createRequire(import.meta.url)('../package.json'))

const program = new Command()

const base = (process.env.GIFTSOFPROMETHEUS_URL || 'https://giftsofprometheus.com').replace(/\/$/, '')

// The CLI talks only to the public Knowledge and account APIs
const publicApi = ['/api/knowledge/', '/api/account/', '/api/auth/device/']

// The XDG spec says to ignore a relative XDG_CONFIG_HOME; honouring it would put the token under the working directory, often a Git checkout
const configHome = process.env.XDG_CONFIG_HOME && isAbsolute(process.env.XDG_CONFIG_HOME) ? process.env.XDG_CONFIG_HOME : join(homedir(), '.config')

const directory = join(configHome, 'giftsofprometheus')

const credentials = join(directory, 'credentials.json')

// A device code started by `login --start` and not yet confirmed; it can be exchanged for a session, so it is kept like one
const pendingLogin = join(directory, 'login.json')

// The onboarding draft lives outside the project next to the session, so it survives `login` between `deck` and `finish`
const onboardingDraft = join(directory, 'onboarding.json')

// When the daily update check last ran and what npm reported then
const updateState = join(directory, 'update.json')

// A random id of this installation, sent as X-Client-Id so the service counts a guest CLI as one client in its analytics
const clientFile = join(directory, 'client.json')

type ClientId = { id: string }

let clientId: Promise<string | null> | undefined

/** Created once; a config folder that cannot be written only drops the header, it never fails a command */
function installationId(): Promise<string | null> {
  clientId ??= (async () => {
    try {
      const parsed = z.object({ id: z.uuid() }).safeParse(JSON.parse(await readFile(clientFile, 'utf8')))

      if (parsed.success) return parsed.data.id
    } catch {}

    const id = randomUUID()

    try {
      await saveJson(clientFile, { id })

      return id
    } catch {
      return null
    }
  })()

  return clientId
}

type Credentials = { base: string; token: string }

const credentialsSchema = z.object({ base: z.string(), token: z.string() })

/** Only a missing file means "no session"; a file that cannot be read or parsed may still hold a valid session */
async function storedAny(): Promise<Credentials | null | 'unreadable'> {
  let text: string

  try {
    text = await readFile(credentials, 'utf8')
  } catch (e) {
    return e instanceof Error && 'code' in e && e.code === 'ENOENT' ? null : 'unreadable'
  }

  try {
    const parsed = credentialsSchema.safeParse(JSON.parse(text))

    return parsed.success ? parsed.data : 'unreadable'
  } catch {
    return 'unreadable'
  }
}

async function stored(): Promise<Credentials | null> {
  const value = await storedAny()

  return value !== 'unreadable' && value?.base === base ? value : null
}

/** `code` and `nextStep` come from the service: the code is stable, the next step says what to do about it */
class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 1,
    readonly code?: string,
    readonly nextStep?: string
  ) {
    super(message)
  }
}

// A fresh 0600 file renamed into place: a secret never lands in an existing file with loose permissions or behind a symlink
async function saveJson(file: string, value: Credentials | DeviceLogin | Draft | UpdateState | ClientId | SkillState) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)

  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) throw new ApiError(`Unsafe config directory: ${directory}`)
  await chmod(directory, 0o700)
  const temporary = join(directory, `.state-${randomUUID()}.json`)

  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  } catch (e) {
    await unlink(temporary).catch(() => {})
    throw e
  }
}

/** A missing, damaged or foreign-service state file reads as absent: these files are only conveniences, never a session */
async function readState<T>(file: string, schema: z.ZodType<T & { base: string }>): Promise<T | null> {
  try {
    const parsed = schema.safeParse(JSON.parse(await readFile(file, 'utf8')))

    return parsed.success && parsed.data.base === base ? parsed.data : null
  } catch {
    return null
  }
}

// Set when a command returns a response it could not check; the text form then shows it as JSON instead of reading it
let unchecked = false

async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  authenticated = true,
  // An optional report (`skill personalize`) waits briefly and never repeats
  { timeoutMs = 30_000, retry = true }: { timeoutMs?: number; retry?: boolean } = {}
): Promise<unknown> {
  if (!path.startsWith('/') || path.includes('\\'))
    throw new ApiError(`Invalid API path: pass a full path starting with ${publicApi.join(', ')}, e.g. /api/knowledge/profile`)
  const target = new URL(base + path)

  // Checked after URL normalization, so `..` cannot leave the public API
  if (target.origin !== new URL(base).origin || !publicApi.some(prefix => target.pathname.startsWith(prefix)))
    throw new ApiError(`Path must start with ${publicApi.join(', ')}`)

  if (target.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) throw new ApiError('HTTPS is required outside localhost')
  const credential = authenticated ? await stored() : null
  const headers = new Headers({ 'Content-Type': 'application/json', 'X-Knowledge-Client': 'agent', 'User-Agent': `giftsofprometheus/${version}` })

  if (credential) headers.set('Authorization', `Bearer ${credential.token}`)
  const installation = await installationId()

  if (installation) headers.set('X-Client-Id', installation)
  const tail = await skillTailHeader()

  if (tail) headers.set('X-Skill-Tail', tail)

  for (let attempt = 1; ; attempt++) {
    let response: Response

    try {
      response = await fetch(target, {
        method,
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (e) {
      // A refused or reset connection never reached the service, so any method may repeat. A timeout may have, so it does not
      if (retry && attempt < RETRY_DELAYS_MS.length + 1 && !(e instanceof Error && e.name === 'TimeoutError')) {
        await sleep(RETRY_DELAYS_MS[attempt - 1])
        continue
      }

      throw new ApiError(`The service is unreachable: ${e instanceof Error ? e.message : 'network error'}. Try again in a minute.`)
    }

    const data = await response.json().catch(() => ({}))

    if (response.ok) return data

    const failure = z
      .object({ error_description: z.string().optional(), error: z.string().optional(), code: z.string().optional(), nextStep: z.string().optional() })
      .safeParse(data)

    const code = failure.success ? failure.data.code : undefined

    // 502-504 without a service error code come from the proxy in front of the service: a restart or a dropped connection
    if (GATEWAY_STATUSES.has(response.status) && code === undefined) {
      if (retry && attempt < RETRY_DELAYS_MS.length + 1) {
        await sleep(RETRY_DELAYS_MS[attempt - 1])
        continue
      }

      throw new ApiError(`The service is temporarily unavailable (HTTP ${response.status}). Try again in a minute.`, response.status)
    }

    const message = failure.success ? failure.data.error_description || failure.data.error || `HTTP ${response.status}` : `HTTP ${response.status}`
    const nextStep = failure.success && failure.data.nextStep ? printable(failure.data.nextStep).slice(0, 500) : undefined

    throw new ApiError(printable(message).slice(0, 500), response.status, code === undefined ? undefined : printable(code).slice(0, 100), nextStep)
  }
}

// Two repeats after a gateway error or a connection failure: a deploy switch or a dropped keep-alive connection passes in seconds
const RETRY_DELAYS_MS = [500, 1500]

const GATEWAY_STATUSES = new Set([502, 503, 504])

/** Turns a command's result into text for a person; null when the result has an unexpected shape */
type Render<Args extends unknown[]> = (value: unknown, ...args: Args) => string | null

/** A renderer that checks the shape first, so a service change shows the JSON instead of crashing the command */
const view =
  <T, Args extends unknown[] = unknown[]>(schema: z.ZodType<T>, format: (value: T, ...args: Args) => string): Render<Args> =>
  (value, ...args) => {
    const parsed = schema.safeParse(value)

    try {
      return parsed.success ? format(parsed.data, ...args) : null
    } catch {
      return null
    }
  }

// Next-step hints go to stderr after the output, so a person reads them last and stdout stays the result
const hints: Array<{ json: string; human: string | null }> = []

/** `human` replaces the line for a person; null shows nothing, when the text output already says it */
const hint = (json: string, human: string | null = json) => hints.push({ json, human: human === null ? null : printable(human) })

// JSON.stringify escapes C0 control characters but not DEL and C1; a person's terminal would interpret those
// oxlint-disable-next-line no-control-regex -- matching control characters is the purpose of this expression
const escapeC1 = (json: string) => json.replace(/[\u007f-\u009f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

// With --json: one JSON document for agents. Without it: text for a person, or indented JSON where a command has no text form
function out<Args extends unknown[]>(value: unknown, render: Render<Args> | undefined, args: Args) {
  const json = program.opts().json

  console.log(json ? JSON.stringify(value) : ((unchecked ? null : render?.(value, ...args)) ?? escapeC1(JSON.stringify(value, null, 2))))

  for (const line of hints.splice(0)) {
    if (json) console.error(line.json)
    else if (line.human !== null) console.error(text.dim(line.human))
  }
}

// What an agent must do on 401. It is in the error itself, so an agent without the skill also knows to sign the user in
const SIGN_IN_STEPS =
  'Sign the user in: run `login --start` with the same launcher and --json, give the user verificationUrl and userCode in one line, run `login --wait` (it waits for the confirmation), then repeat this command.'

const interactive = () => !program.opts().json && Boolean(process.stdin.isTTY && process.stderr.isTTY)

function run<Args extends unknown[]>(fn: (...args: Args) => Promise<unknown>, render?: Render<Args>) {
  return async (...args: Args) => {
    try {
      try {
        out(await fn(...args), render, args)
      } catch (e) {
        // A person in a terminal is taken through the browser confirmation and gets the answer, instead of an error to act on
        if (!(e instanceof ApiError && e.status === 401 && interactive())) throw e
        const device = await startLogin()
        console.error(`Sign-in needed. Open ${verificationUrl(device.userCode)} and confirm the code ${device.userCode}`)
        await waitLogin(device)
        console.error(text.signedIn({ signedIn: true }))
        out(await fn(...args), render, args)
      }
    } catch (e) {
      hints.length = 0
      const message = e instanceof Error ? e.message : 'Unknown error'
      const status = e instanceof ApiError ? e.status : 1
      const code = e instanceof ApiError ? e.code : undefined
      // On 401 the CLI's own steps win: they say how to sign in from an agent, which the service cannot know. A person runs login
      const signIn = program.opts().json ? SIGN_IN_STEPS : `sign in with ${cmd()} login, then repeat this command`
      const nextStep = status === 401 ? signIn : e instanceof ApiError ? e.nextStep : undefined

      if (program.opts().json) console.log(JSON.stringify({ error: { message, status, ...(code ? { code } : {}), ...(nextStep ? { nextStep } : {}) } }))
      else {
        console.error(printable(message))

        if (nextStep) console.error(`Next: ${printable(nextStep)}`)
      }

      process.exitCode = 1
    }
  }
}

const packageRoot = fileURLToPath(new URL('../', import.meta.url))

const bundledSkill = join(packageRoot, 'skills', 'giftsofprometheus')

// Installed from npm (global or a project dependency), not a one-off npx, pnpm dlx or bunx run and not a source checkout:
// only then is there an installed version to update
const installed = /[\\/]node_modules[\\/]/.test(packageRoot) && !/[\\/](_npx|dlx|bunx-[^\\/]*)[\\/]/.test(packageRoot)

const DAY_MS = 24 * 60 * 60 * 1000

type UpdateState = { base: string; checkedAt: number; latest: string | null }

const updateStateSchema = z.object({ base: z.string(), checkedAt: z.number(), latest: z.string().nullable() })

const historySchema = z.array(z.object({ version: z.string(), hash: z.string(), description: z.string().nullable() }))

const updateCommand = /[\\/]pnpm[\\/]global[\\/]/.test(packageRoot)
  ? 'pnpm add -g @giftsofprometheus/cli@latest'
  : /[\\/]\.bun[\\/]install[\\/]global[\\/]/.test(packageRoot)
    ? 'bun add -g @giftsofprometheus/cli@latest'
    : 'npm install -g @giftsofprometheus/cli@latest'

// The command a person typed, so a hint can be pasted back as is
const detectedLauncher = /[\\/]_npx[\\/]/.test(packageRoot)
  ? 'npx @giftsofprometheus/cli'
  : /[\\/]bunx-[^\\/]*[\\/]/.test(packageRoot)
    ? 'bunx @giftsofprometheus/cli'
    : /[\\/]dlx[\\/]/.test(packageRoot)
      ? 'pnpm dlx @giftsofprometheus/cli'
      : 'giftsofprometheus'

// --json output keeps the commands it has always named: agents follow them, and the skill says how to run the CLI
const jsonLauncher = /[\\/]_npx[\\/]/.test(packageRoot) ? 'npx @giftsofprometheus/cli' : 'giftsofprometheus'

const cmd = () => (program.opts().json ? jsonLauncher : detectedLauncher)

const context = { launcher: detectedLauncher, base }

const shortPath = (path: string) => (path.startsWith(homedir()) ? '~' + path.slice(homedir().length) : path)

async function fetchLatest(): Promise<string | null> {
  try {
    const response = await fetch('https://registry.npmjs.org/@giftsofprometheus/cli/latest', {
      headers: { Accept: 'application/json', 'User-Agent': `giftsofprometheus/${version}` },
      redirect: 'error',
      signal: AbortSignal.timeout(1500),
    })

    if (!response.ok) return null
    const parsed = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+/) }).safeParse(await response.json())

    return parsed.success ? parsed.data.version : null
  } catch {
    return null
  }
}

/** The latest npm version, asked at most once a day; `fresh` is true when this call asked npm */
async function latestVersion(force = false): Promise<{ latest: string | null; fresh: boolean }> {
  const state = await readState(updateState, updateStateSchema)

  if (!force && state && Date.now() - state.checkedAt < DAY_MS) return { latest: state.latest, fresh: false }
  // npx and source runs never ask npm: they already run the version that was asked for
  const latest = installed ? ((await fetchLatest()) ?? state?.latest ?? null) : null

  // A failed check also counts, so an offline machine does not wait for npm on every run
  await saveJson(updateState, { base, checkedAt: Date.now(), latest }).catch(() => {})

  return { latest, fresh: true }
}

type SkillStatus = 'current' | 'outdated' | 'modified' | 'linked'

// The copy `skill personalize` last wrote, for the X-Skill-Tail header: it may sit outside the agent folders (a plugin
// copy). The service counts in its analytics whether a personal tail is installed, never what it says
const skillState = join(directory, 'skill.json')

const skillStateSchema = z.object({ base: z.string(), file: z.string() })

type SkillState = z.infer<typeof skillStateSchema>

// Only the frontmatter is needed, so a large or odd file never costs more than this
const SKILL_HEAD_BYTES = 8192

// A slow disk only drops the header, it never holds a command back
const SKILL_TAIL_BUDGET_MS = 500

let skillTailValue: Promise<string | null> | undefined

/** Topics in the tail of one copy of this skill, or null when the path is not a readable copy */
async function copyTail(path: string): Promise<number | null> {
  try {
    const file = await open(path, 'r')

    try {
      if (!(await file.stat()).isFile()) return null
      const buffer = Buffer.alloc(SKILL_HEAD_BYTES)
      const { bytesRead } = await file.read(buffer, 0, SKILL_HEAD_BYTES, 0)
      const head = buffer.subarray(0, bytesRead).toString('utf8')

      if (!/^---\r?\nname: giftsofprometheus\r?\n/.test(head)) return null
      const line = skillDescription(head)

      return line ? Math.min(10, tailCount(line)) : null
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

/** Topics in the tail of the copies in the agent folders and the one personalize wrote (the most of any), or `none` */
async function installedTail(): Promise<number | 'none'> {
  const state = await readState(skillState, skillStateSchema)
  const paths = [...skillDirectories().map(folder => join(folder, 'SKILL.md')), ...(state ? [state.file] : [])]
  const real = new Set(await Promise.all(paths.map(path => realpath(path).catch(() => null))))
  const tails = (await Promise.all([...real].map(path => (path ? copyTail(path) : null)))).filter(tail => tail !== null)

  return tails.length ? Math.max(...tails) : 'none'
}

/** The X-Skill-Tail value, read once per run; a failure or a slow disk only drops the header */
function skillTailHeader(): Promise<string | null> {
  skillTailValue ??= new Promise<string | null>(done => {
    const timer = setTimeout(() => done(null), SKILL_TAIL_BUDGET_MS)

    installedTail().then(
      tail => {
        clearTimeout(timer)
        done(String(tail))
      },
      () => {
        clearTimeout(timer)
        done(null)
      }
    )
  })

  return skillTailValue
}

/** After `skill personalize`: remember a copy it could write and tell the service what happened. Never fails or waits long */
type TailSource = 'explicit' | 'inferred' | 'mixed'

async function reportPersonalize(file: string, result: 'written' | 'unchanged' | 'write_failed', topics: number, source: TailSource | null) {
  if (result !== 'write_failed') await saveJson(skillState, { base, file }).catch(() => {})
  skillTailValue = undefined
  const body = source ? { result, topics, tail_source: source } : { result, topics }
  await request('/api/knowledge/skill/personalize', 'POST', body, true, { timeoutMs: 2000, retry: false }).catch(() => {})
}

// Where agents and `npx skills add` keep personal and project skills
function skillDirectories() {
  const roots = [homedir(), process.cwd()]
  const homes = [process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME].filter((value): value is string => Boolean(value && isAbsolute(value)))

  return [
    ...roots.flatMap(root => ['.agents', '.claude', '.codex', '.cursor'].map(agent => join(root, agent, 'skills', 'giftsofprometheus'))),
    ...homes.map(home => join(home, 'skills', 'giftsofprometheus')),
  ]
}

async function skillHistory() {
  return historySchema.parse(JSON.parse(await readFile(join(packageRoot, 'skills', 'history.json'), 'utf8')))
}

/**
 * Installed copies of the skill, each once even when several agent folders link to it.
 * The description line is not compared: a custom one, or a personal tail, does not make a copy outdated.
 */
async function installedSkills(): Promise<Array<{ path: string; file: string; status: SkillStatus; version: string | null }>> {
  const bundled = await realpath(bundledSkill)
  const current = skillHash(await readFile(join(bundled, 'SKILL.md'), 'utf8'))
  const history = await skillHistory()
  const seen = new Set<string>()
  const found = []

  for (const folder of skillDirectories()) {
    let real: string

    try {
      real = await realpath(folder)
    } catch {
      continue
    }

    if (seen.has(real)) continue
    seen.add(real)

    if (real === bundled) {
      found.push({ path: shortPath(folder), file: join(real, 'SKILL.md'), status: 'linked' as const, version })
      continue
    }

    let text: string

    try {
      text = await readFile(join(real, 'SKILL.md'), 'utf8')
    } catch {
      continue
    }

    const hash = skillHash(text)
    const known = history.findLast(entry => entry.hash === hash)
    const status: SkillStatus = hash === current ? 'current' : known ? 'outdated' : 'modified'

    found.push({ path: shortPath(folder), file: join(real, 'SKILL.md'), status, version: known?.version ?? null })
  }

  return found
}

async function updateSkills(force: boolean) {
  const bundled = await readFile(join(bundledSkill, 'SKILL.md'), 'utf8')
  const stock = (await skillHistory()).flatMap(entry => (entry.description ? [entry.description] : []))
  const updated = []
  const unchanged = []

  for (const skill of await installedSkills()) {
    if (skill.status !== 'outdated' && !(force && skill.status === 'modified')) {
      unchanged.push({ path: skill.path, status: skill.status })
      continue
    }

    const text = mergeSkill(bundled, await readFile(skill.file, 'utf8'), stock)
    const temporary = `${skill.file}.${randomUUID()}.tmp`

    try {
      await writeFile(temporary, text, { mode: (await stat(skill.file)).mode & 0o777, flag: 'wx' })
      await rename(temporary, skill.file)
    } catch (e) {
      await unlink(temporary).catch(() => {})
      throw e
    }

    updated.push({ path: skill.path, from: skill.version })
  }

  return { version, updated, unchanged }
}

const updateCheckDisabled = () => Boolean(process.env.GIFTSOFPROMETHEUS_NO_UPDATE_CHECK || process.env.CI)

/** Once a day, after a command: a line on stderr when the CLI or an installed skill is behind. Never fails the command */
async function updateNotice() {
  if (updateCheckDisabled()) return

  try {
    const { latest, fresh } = await latestVersion()

    if (!fresh) return
    const lines = []

    if (installed && latest && newerVersion(latest, version))
      lines.push(`Update: giftsofprometheus ${latest} is available (installed ${version}). Run: ${updateCommand}`)

    for (const skill of await installedSkills())
      if (skill.status === 'outdated') lines.push(`Update: the agent skill in ${skill.path} is older than this CLI. Run: giftsofprometheus skill update`)

    if (lines.length) console.error(lines.join('\n'))
  } catch {}
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Windows is skipped: a short program name is looked up in the current directory before PATH, so a checkout could plant cmd.exe,
// and cmd.exe also interprets & | ^ in the URL. The printed link is enough there
function openBrowser(url: URL) {
  const opener = process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'win32' ? null : 'xdg-open'

  // Set by the tests, and useful on a remote machine where the local browser is the wrong one
  if (!opener || process.env.GIFTSOFPROMETHEUS_NO_BROWSER) return
  const child = spawn(opener, [url.href], { detached: true, stdio: 'ignore', shell: false })
  child.on('error', () => {})
  child.unref()
}

type DeviceLogin = { base: string; deviceCode: string; userCode: string; interval: number; deadline: number }

const deviceLoginSchema = z.object({
  base: z.string(),
  deviceCode: z.string().min(1).max(512),
  userCode: z.string().regex(/^[A-Z0-9-]{4,32}$/i),
  interval: z.number().int().min(1).max(60),
  deadline: z.number(),
})

const verificationUrl = (userCode: string) => {
  const url = new URL('/device', base)
  url.searchParams.set('user_code', userCode)

  return url
}

async function startLogin(): Promise<DeviceLogin> {
  // Bounded: a zero interval would poll without pause and a huge expiry would poll forever
  const data = z
    .object({
      user_code: z.string().regex(/^[A-Z0-9-]{4,32}$/i),
      device_code: z.string().min(1).max(512),
      interval: z.number().int().min(1).max(60).optional(),
      expires_in: z.number().int().min(1).max(1800).optional(),
    })
    .parse(await request('/api/auth/device/code', 'POST', { client_id: 'giftsofprometheus' }, false))

  openBrowser(verificationUrl(data.user_code))

  return { base, deviceCode: data.device_code, userCode: data.user_code, interval: data.interval ?? 5, deadline: Date.now() + (data.expires_in ?? 900) * 1000 }
}

const loginPrompt = (device: DeviceLogin) => ({
  verificationUrl: verificationUrl(device.userCode).href,
  userCode: device.userCode,
  expiresIn: Math.max(0, Math.round((device.deadline - Date.now()) / 1000)),
})

/** Without a flag: start and wait in one run. `--start` returns the link at once so an agent can show it; `--wait` finishes that login */
async function login(options: { start?: boolean; wait?: boolean }) {
  if (options.start && options.wait) throw new ApiError('Use either --start or --wait')

  if (options.wait) {
    const device = await readState(pendingLogin, deviceLoginSchema)

    if (!device) throw new ApiError('No pending login: run giftsofprometheus login --start first')

    return waitLogin(device)
  }

  const device = await startLogin()

  if (options.start) {
    await saveJson(pendingLogin, device)

    return loginPrompt(device)
  }

  console.error(`Open ${verificationUrl(device.userCode)} and confirm the code ${device.userCode}`)

  if (!program.opts().json) console.error(text.dim('Waiting for the confirmation…'))

  return waitLogin(device)
}

async function waitLogin(device: DeviceLogin) {
  let interval = device.interval
  const deadline = device.deadline
  const data = { device_code: device.deviceCode }

  while (Date.now() < deadline) {
    await sleep(interval * 1000)

    try {
      const token = z
        .object({ access_token: z.string().min(1), expires_in: z.number().optional() })
        .parse(
          await request(
            '/api/auth/device/token',
            'POST',
            { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: data.device_code, client_id: 'giftsofprometheus' },
            false
          )
        )

      await saveJson(credentials, { base, token: token.access_token })
      await unlink(pendingLogin).catch(() => {})

      return { signedIn: true, expiresIn: token.expires_in }
    } catch (e) {
      const message = e instanceof Error ? e.message : ''

      // 429: a server limit on polling; back off like slow_down instead of failing a login the user may already have confirmed
      if (/slow.down|too frequently/i.test(message) || (e instanceof ApiError && e.status === 429)) {
        interval = Math.min(interval + 5, 60)
        continue
      }

      if (/authorization.pending|pending/i.test(message)) continue
      throw e
    }
  }

  await unlink(pendingLogin).catch(() => {})
  throw new ApiError('Device code expired')
}

async function resolveTalk(value: string) {
  return z
    .object({ id: z.number(), slug: z.string() })
    .loose()
    .parse(await request(`/api/knowledge/talks/${encodeURIComponent(value)}`, 'GET', undefined, false))
}

// The service checks the recId against its own deliveries; the CLI only refuses what cannot be one
const recIdOption = z.uuid()

/** The content query: `part=outline` asks the service for the chapters without the transcript, which it does not count as a read */
function contentQuery(recId: string | undefined, outline: boolean | undefined) {
  const params = new URLSearchParams()

  if (recId !== undefined) params.set('recId', recIdOption.parse(recId))

  if (outline) params.set('part', 'outline')
  const query = params.toString()

  return query ? `?${query}` : ''
}

async function event(talk: string, type: 'bookmark' | 'unbookmark' | 'like' | 'dislike' | 'not_interested' | 'clear_reaction', recId?: string) {
  const item = await resolveTalk(talk)
  // With a recId the service takes the context from that list; `similar` only passes its check
  const source = recId === undefined ? { context: 'talk_page' } : { context: 'similar', recId: recIdOption.parse(recId) }

  return request('/api/knowledge/events', 'POST', [{ id: randomUUID(), type, talkId: item.id, ...source }])
}

program.exitOverride()

program.configureOutput({
  outputError: (str, write) => {
    if (!program.opts().json) write(str)
  },
})

program.name('giftsofprometheus').description('Gifts of Prometheus catalog and personal account').version(version).option('--json', 'machine-readable output')

program
  .command('login')
  .description('Authorize this CLI in a browser')
  .option('--start', 'print the confirmation link and code, then exit; finish with login --wait')
  .option('--wait', 'wait for the confirmation of a login started with --start')
  .action(
    run(login, value => {
      const prompt = text.loginPromptSchema.safeParse(value)

      return prompt.success ? text.loginPrompt(context, prompt.data) : view(text.signedInSchema, text.signedIn)(value)
    })
  )

program
  .command('logout')
  .description('Revoke this CLI session')
  .action(
    run(
      async () => {
        const saved = await storedAny()

        // The session in an unreadable file cannot be revoked from here, and deleting the file would hide that it may still be valid
        if (saved === 'unreadable')
          throw new ApiError(
            `Cannot read ${credentials}, so this session was not revoked. Disconnect the device on ${new URL('/account', base)}, then delete the file`
          )

        // A session issued by another service is neither revoked nor deleted: removing the file would leave that session valid
        if (saved && saved.base !== base) throw new ApiError(`The stored session belongs to ${saved.base}; run logout with GIFTSOFPROMETHEUS_URL=${saved.base}`)

        if (!saved) return { signedOut: true }

        try {
          await request('/api/account/logout', 'POST')
        } catch (e) {
          if (!(e instanceof ApiError) || e.status !== 401) throw e
        }

        await unlink(credentials).catch(() => {})

        return { signedOut: true }
      },
      () => 'Signed out.'
    )
  )

program
  .command('whoami')
  .description('Show the current account')
  .action(run(() => request('/api/account/me'), view(text.accountSchema, text.account)))

program
  .command('doctor')
  .description('Check configuration, server and authorization')
  .action(
    run(
      async () => {
        const credential = await stored()

        let reachable = false,
          authenticated = false

        try {
          await request('/api/knowledge/talks', 'GET', undefined, false)
          reachable = true

          if (credential) {
            await request('/api/account/me')
            authenticated = true
          }
        } catch {}

        const latest = installed && !updateCheckDisabled() ? (await latestVersion(true)).latest : null
        const skills = await installedSkills().catch(() => [])

        return {
          base,
          reachable,
          authenticated,
          authSource: credential ? 'config' : 'missing',
          configPath: credentials,
          // `installed: false` for npx and source runs: they already use the version they asked for
          update: { installed, current: version, latest, available: Boolean(installed && latest && newerVersion(latest, version)), command: updateCommand },
          skills: skills.map(skill => ({ path: skill.path, status: skill.status, version: skill.version })),
          nextStep: !reachable ? 'Check GIFTSOFPROMETHEUS_URL and server availability' : !authenticated ? 'Run giftsofprometheus login' : null,
        }
      },
      view(text.doctorSchema, value => text.doctor(context, value))
    )
  )

program
  .command('ask')
  .description('Find relevant passages in talk transcripts')
  .argument('<query>', 'question or search formulation')
  .option(
    '--q <query>',
    'another formulation; the query and --q together are at most three, so at most two --q',
    (value: string, previous: string[]) => [...previous, value],
    []
  )
  .option('--limit <n>', 'maximum number of talks (1-20)')
  .option('--per-talk <n>', 'maximum passages per talk (1-3)')
  .action(
    run(
      (query: string, options: { q: string[]; limit?: string; perTalk?: string }) => {
        const queries = askQueries([query, ...options.q])

        const number = z.string().regex(/^\d+$/)
        const params = new URLSearchParams()

        for (const value of queries) params.append('q', value)

        if (options.limit !== undefined) params.set('limit', number.parse(options.limit))

        if (options.perTalk !== undefined) params.set('perTalk', number.parse(options.perTalk))

        return request(`/api/knowledge/passages?${params}`)
      },
      view(text.passagesSchema, value => text.passages(context, value))
    )
  )

/** The service takes one to three texts of up to 200 characters; a plain message tells an agent what to drop */
function askQueries(values: string[]) {
  const queries = values.map(value => value.trim())

  if (queries.some(value => !value)) throw new ApiError('Empty formulation: the query and every --q need text')

  if (queries.length > 3)
    throw new ApiError(`ask takes at most 3 formulations in total: the query and up to two --q. Got ${queries.length}; drop ${queries.length - 3}.`)
  const long = queries.find(value => value.length > 200)

  if (long !== undefined) throw new ApiError(`A formulation is longer than 200 characters (${long.length}); shorten it`)

  return queries
}

/** Seconds as `90`, `1:30` or `1:02:03` */
function seconds(value: string) {
  if (!/^\d+(:\d{1,2}){0,2}$/.test(value)) throw new ApiError(`Invalid time "${value}": use seconds (90), m:ss (1:30) or h:mm:ss (1:02:03)`)

  return value.split(':').reduce((total, part) => total * 60 + Number(part), 0)
}

const contentShape = z.object({ transcript: z.array(z.object({ startMs: z.number() }).loose()) }).loose()

/** An outline as the service answers `part=outline` (GOP-67): the chapters and the number of segments, no transcript */
const outlineShape = z.object({ transcriptSegments: z.number() }).loose()

const talks = program.command('talks').description('Browse talks')

talks
  .command('list')
  .description('List published talks, page by page')
  .option('--page <page>', 'page number', '1')
  .action(
    run(
      (options: { page: string }) => request(`/api/knowledge/talks?page=${encodeURIComponent(options.page)}`, 'GET', undefined, false),
      view(text.pageSchema, value => text.talkPage(context, value, page => `talks list --page ${page}`, 'No talks on this page.'))
    )
  )

talks
  .command('search')
  .description('Search published talks by title, summary, speaker or topic')
  .argument('<query>')
  .option('--page <page>', 'page number', '1')
  .action(
    run(
      (query: string, options: { page: string }) => {
        // The service answers an empty query with the whole catalog, which an agent would take for search results
        if (!query.trim()) throw new ApiError('Empty search query. To browse the catalog, use: giftsofprometheus talks list')

        return request(`/api/knowledge/talks?q=${encodeURIComponent(query)}&page=${encodeURIComponent(options.page)}`)
      },
      view(text.pageSchema, (value, query: string) =>
        text.talkPage(
          context,
          // Search is public: with an expired session the service answers it as anonymous and accepts that recId only from
          // the site, and the response does not say which it was. A person opens a found talk without one
          { ...value, recId: undefined },
          page => `talks search --page ${page} -- ${shellQuote(query)}`,
          `Nothing found. Search the transcripts instead: ${cmd()} ask -- ${shellQuote(query)}`
        )
      )
    )
  )

talks
  .command('get')
  .description('Show one talk: summary, speakers, topics and links')
  .argument('<slug-or-id>')
  .action(
    run(
      async (id: string) => {
        const talk = await resolveTalk(id)
        // The next step after the summary is the transcript; stdout stays the talk's JSON
        const signedIn = Boolean(await stored())
        hint(`Next: the full transcript — ${cmd()} talks content ${talk.slug}${signedIn ? '' : ' (asks you to sign in in the browser first)'}`)

        return talk
      },
      view(text.talkSchema, value => text.talkDetails(context, value))
    )
  )

talks
  .command('content')
  .description('Read the transcript with chapters and timestamps; requires login')
  .argument('<slug-or-id>')
  .option('--rec-id <recId>', 'recId of the list the talk came from (feed, search or similar)')
  .option('--from <time>', 'keep transcript segments that start at or after this time: seconds, m:ss or h:mm:ss')
  .option('--to <time>', 'keep transcript segments that start before this time')
  .option('--outline', 'speakers, chapters and publication without the transcript; not counted as reading the talk')
  .action(
    run(
      async (id: string, options: { recId?: string; from?: string; to?: string; outline?: boolean }) => {
        const query = contentQuery(options.recId, options.outline)
        const from = options.from === undefined ? 0 : seconds(options.from) * 1000
        const to = options.to === undefined ? Infinity : seconds(options.to) * 1000

        if (from >= to) throw new ApiError('--from must be earlier than --to')
        const talk = await resolveTalk(id)
        const raw = await request(`/api/knowledge/talks/${encodeURIComponent(String(talk.slug))}/content${query}`, 'POST')
        const whole = !options.outline && options.from === undefined && options.to === undefined
        // A service before GOP-67 ignores `part` and sends the transcript; then the outline is cut here as before
        const served = options.outline ? outlineShape.safeParse(raw) : null
        const parsed = whole || served?.success ? null : contentShape.safeParse(raw)

        if (parsed && !parsed.success) {
          if (program.opts().json) throw parsed.error
          unchecked = true
        }

        const content = parsed?.success ? parsed.data : null

        // A range keeps the chapters, so an agent still sees where it is in the talk
        const result = served?.success
          ? served.data
          : content === null
            ? raw
            : options.outline
              ? { ...content, transcript: undefined, transcriptSegments: content.transcript.length }
              : { ...content, transcript: content.transcript.filter(segment => segment.startMs >= from && segment.startMs < to) }

        // After the transcript: talks like this one, or saving it if the user found it useful
        hint(
          `Next: similar talks — ${cmd()} talks similar ${talk.slug}; save it if the user asks — ${cmd()} favorites add ${talk.slug}`,
          `Next: similar talks — ${cmd()} talks similar ${talk.slug}; save to favorites — ${cmd()} favorites add ${talk.slug}${options.recId ? ` --rec-id ${options.recId}` : ''}`
        )

        return result
      },
      (value, _, options: { outline?: boolean }) => view(options.outline ? text.outlineSchema : text.contentSchema, text.transcript)(value)
    )
  )

talks
  .command('similar')
  .description('Up to four talks like this one, each with a reason')
  .argument('<slug-or-id>')
  .action(
    run(
      async (id: string) => {
        const talk = await resolveTalk(id)

        // Public; with a session the list gets a recId, and each item's contentUrl carries it
        const result = z
          .object({ recId: z.string().optional() })
          .loose()
          .parse(await request(`/api/knowledge/talks/${encodeURIComponent(String(talk.slug))}/similar`))

        if (result.recId) hint(`Next: open one with ${cmd()} talks content <slug> --rec-id ${result.recId}`, null)

        return result
      },
      view(text.listSchema, value => text.talkList(context, value, 'No similar talks yet.'))
    )
  )

const reactionTypes = { like: 'like', dislike: 'dislike', 'not-interested': 'not_interested', clear: 'clear_reaction' } as const

talks
  .command('react')
  .description('Record what the user said about a talk: like, dislike, not-interested or clear')
  .argument('<slug-or-id>')
  .argument('<reaction>', Object.keys(reactionTypes).join(' | '))
  .option('--rec-id <recId>', 'recId of the list the talk came from')
  .action(
    run(
      async (id: string, reaction: string, options: { recId?: string }) => {
        const type = z.enum(['like', 'dislike', 'not-interested', 'clear']).parse(reaction)

        return event(id, reactionTypes[type], options.recId)
      },
      (_, id: string, reaction: string) =>
        reaction === 'clear' ? `Cleared the reaction to ${printable(id)}.` : `Recorded: ${printable(reaction)} for ${printable(id)}.`
    )
  )

const favorites = program.command('favorites').description('Manage bookmarks')

favorites
  .command('list')
  .description('List saved talks')
  .option('--page <page>', 'page number', '1')
  .option('--limit <limit>', 'page size, max 50', '20')
  .action(
    run(
      (o: { page: string; limit: string }) => request(`/api/knowledge/favorites?page=${encodeURIComponent(o.page)}&limit=${encodeURIComponent(o.limit)}`),
      view(text.pageSchema, (value, o: { page: string; limit: string }) =>
        text.talkPage(
          context,
          value,
          page => `favorites list --page ${page} --limit ${shellQuote(o.limit)}`,
          `No favorites yet. Save a talk with: ${cmd()} favorites add <slug>`
        )
      )
    )
  )

favorites
  .command('add')
  .description('Save a talk to favorites')
  .argument('<slug-or-id>')
  .option('--rec-id <recId>', 'recId of the list the talk came from')
  .action(
    run(
      (id: string, options: { recId?: string }) => event(id, 'bookmark', options.recId),
      (_, id: string) => `Saved ${printable(id)} to favorites.`
    )
  )

favorites
  .command('remove')
  .description('Remove a talk from favorites')
  .argument('<slug-or-id>')
  .action(
    run(
      (id: string) => event(id, 'unbookmark'),
      (_, id: string) => `Removed ${printable(id)} from favorites.`
    )
  )

const profile = program.command('profile').description('Read or update interests')

profile
  .command('get')
  .description('Show interests, topics inferred from reading and the current task')
  .action(run(() => request('/api/knowledge/profile'), view(text.profileSchema, text.profile)))

const levels = z.enum(['high', 'interested', 'not_interested'])

// The service omits the slug of a deleted topic; such interests are dropped on update
const currentProfile = z.object({ interests: z.array(z.object({ topic: z.string().optional(), level: levels })), queryText: z.string() })

const collect = (value: string, previous: string[]) => [...previous, value]

type ProfileOptions = { interest: string[]; removeInterest: string[]; queryText?: string }

// Flags only, no file input: an agent steered by untrusted text cannot be made to upload a local file
async function updateProfile(o: ProfileOptions) {
  const current = currentProfile.parse(await request('/api/knowledge/profile'))
  const interests = new Map(current.interests.flatMap(i => (i.topic ? [[i.topic, i.level] as const] : [])))

  for (const topic of o.removeInterest) interests.delete(topic)

  for (const entry of o.interest) {
    const [topic, level, ...rest] = entry.split('=')
    const parsed = levels.safeParse(level)

    if (!topic || rest.length || !parsed.success) throw new ApiError(`Invalid --interest ${printable(entry)}: use topic=high|interested|not_interested`)
    interests.set(topic, parsed.data)
  }

  return request('/api/knowledge/profile', 'PUT', {
    interests: [...interests].map(([topic, level]) => ({ topic, level })),
    queryText: o.queryText ?? current.queryText,
  })
}

profile
  .command('update')
  .description('Change interests or the current task; fields you do not pass keep their values')
  .option('--interest <topic=level>', 'set a topic to high, interested or not_interested; repeatable', collect, [])
  .option('--remove-interest <topic>', 'remove a topic; repeatable', collect, [])
  .option('--query-text <text>', 'replace the current task; an empty string clears it')
  .action(run(updateProfile, () => `Profile updated. See it with: ${cmd()} profile get`))

const draftLevels = z.enum(['interested', 'not_interested'])

const reactions = z.enum(['like', 'dislike'])

type Draft = {
  base: string
  draftId: string
  interests: Array<{ topic: string; level: z.infer<typeof draftLevels> }>
  /** Talk IDs of the deck in the order shown; card n is deck[n - 1] */
  deck: number[]
  reactions: Array<{ talkId: number; reaction: z.infer<typeof reactions> }>
  queryText?: string
}

const draftSchema = z.object({
  base: z.string(),
  draftId: z.uuid(),
  interests: z.array(z.object({ topic: z.string(), level: draftLevels })),
  deck: z.array(z.number().int().positive()),
  reactions: z.array(z.object({ talkId: z.number().int().positive(), reaction: reactions })),
  queryText: z.string().optional(),
})

const card = z.object({
  id: z.number().int().positive(),
  slug: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  speakers: z.array(z.object({ name: z.string() })).default([]),
  topics: z.array(z.object({ title: z.string() })).default([]),
  event: z.object({ name: z.string() }).nullish(),
})

// A card keeps what an agent shows in a list: the summary's first paragraph, without the bullets, links and media fields
function brief(t: z.infer<typeof card>) {
  return {
    slug: t.slug,
    title: t.title,
    summary: t.description?.split(/\n\s*\n/)[0]?.trim() ?? null,
    speakers: t.speakers.map(s => s.name),
    topics: t.topics.map(s => s.title),
    event: t.event?.name ?? null,
  }
}

async function currentDraft(): Promise<Draft> {
  const draft = await readState(onboardingDraft, draftSchema)

  if (!draft) throw new ApiError('No onboarding draft: run giftsofprometheus onboarding deck first')

  return draft
}

async function onboardingDeck(o: { interest: string[]; queryText?: string }) {
  const interests = new Map<string, z.infer<typeof draftLevels>>()

  for (const entry of o.interest) {
    const [topic, level, ...rest] = entry.split('=')
    const parsed = draftLevels.safeParse(level)

    if (!topic || rest.length || !parsed.success) throw new ApiError(`Invalid --interest ${printable(entry)}: use topic=interested|not_interested`)
    interests.set(topic, parsed.data)
  }

  const draft: Draft = { base, draftId: randomUUID(), interests: [...interests].map(([topic, level]) => ({ topic, level })), deck: [], reactions: [] }

  const { deck } = z.object({ deck: z.array(card) }).parse(await request('/api/knowledge/onboarding/deck', 'POST', { interests: draft.interests }, false))

  await saveJson(onboardingDraft, { ...draft, deck: deck.map(t => t.id), ...(o.queryText?.trim() ? { queryText: o.queryText.trim() } : {}) })

  return { draftId: draft.draftId, deck: deck.map((t, i) => ({ n: i + 1, ...brief(t) })) }
}

// Answers refer to card numbers from `deck`, so an agent can pass the user's reply ("1, 4 yes, 3 no") without looking up IDs
async function onboardingReact(answers: string[]) {
  const draft = await currentDraft()
  const chosen = new Map(draft.reactions.map(r => [r.talkId, r.reaction]))

  for (const answer of answers) {
    const [number, value, ...rest] = answer.split('=')
    const talkId = draft.deck[Number(number) - 1]
    const reaction = reactions.or(z.literal('skip')).safeParse(value)

    if (!/^\d+$/.test(number ?? '') || talkId === undefined || rest.length || !reaction.success)
      throw new ApiError(`Invalid answer ${printable(answer)}: use <card 1-${draft.deck.length}>=like|dislike|skip`)

    if (reaction.data === 'skip') chosen.delete(talkId)
    else chosen.set(talkId, reaction.data)
  }

  const next = { ...draft, reactions: [...chosen].map(([talkId, reaction]) => ({ talkId, reaction })) }

  const { preview } = z
    .object({ preview: z.array(card.extend({ reason: z.string() })) })
    .parse(await request('/api/knowledge/onboarding/preview', 'POST', { interests: next.interests, reactions: next.reactions, shownTalkIds: next.deck }, false))

  await saveJson(onboardingDraft, next)

  return {
    preview: preview.map(t => ({ ...brief(t), reason: t.reason })),
    answered: draft.deck.flatMap((id, i) => (chosen.has(id) ? [{ n: i + 1, reaction: chosen.get(id) }] : [])),
    unanswered: draft.deck.flatMap((id, i) => (chosen.has(id) ? [] : [i + 1])),
  }
}

async function onboardingFinish(o: { queryText?: string }) {
  const draft = await currentDraft()

  if (!(await stored())) throw new ApiError('Not signed in. The onboarding draft is kept until it is saved', 401)
  const queryText = o.queryText?.trim() || draft.queryText

  z.object({ saved: z.literal(true) }).parse(
    await request('/api/knowledge/onboarding', 'POST', {
      draftId: draft.draftId,
      interests: draft.interests,
      reactions: draft.reactions,
      ...(queryText ? { queryText } : {}),
    })
  )

  await unlink(onboardingDraft).catch(() => {})

  return { saved: true }
}

const onboarding = program.command('onboarding').description('Build a starting profile: pick topics, judge a deck of talks, save it to the account')

onboarding
  .command('topics')
  .description('List topics to match interests against; no account needed')
  .action(
    run(
      async () =>
        z
          .object({ topics: z.array(z.object({ slug: z.string(), title: z.string(), section: z.string().nullable() })) })
          .parse(await request('/api/knowledge/topics', 'GET', undefined, false)),
      view(text.topicsSchema, text.topicTree)
    )
  )

onboarding
  .command('deck')
  .description('Start a new draft from topic choices and get up to 8 numbered talks to judge; no account needed')
  .option('--interest <topic=level>', 'set a topic to interested or not_interested; repeatable', collect, [])
  .option('--query-text <text>', 'what the user is working on now; saved with the draft on finish')
  .action(
    run(
      onboardingDeck,
      view(text.deckSchema, value => text.deck(context, value))
    )
  )

onboarding
  .command('react')
  .description('Judge deck cards by number and get the recommendations they lead to; no account needed')
  .argument('<answers...>', 'card=like|dislike|skip, e.g. 1=like 3=dislike')
  .action(
    run(
      onboardingReact,
      view(text.previewSchema, value => text.preview(context, value))
    )
  )

onboarding
  .command('finish')
  .description('Save the draft to the signed-in account')
  .option('--query-text <text>', 'replace the query text kept in the draft')
  .action(run(onboardingFinish, () => `Saved to your account. Recommendations: ${cmd()} feed`))

program
  .command('feed')
  .description('Get personalized recommendations')
  .action(
    run(
      () => request('/api/knowledge/feed'),
      view(text.listSchema, value => text.talkList(context, value, `No recommendations yet. Build a profile with: ${cmd()} onboarding topics`))
    )
  )

program
  .command('request')
  .description('Make an authenticated GET request to a Knowledge API path, e.g. /api/knowledge/profile')
  .argument('<path>')
  .action(run((path: string) => request(path)))

const skill = program
  .command('skill')
  .description('Print the agent skill that matches this CLI version')
  .option('--path', 'print the skill directory instead, for linking into an agent')
  .action(async (options: { path?: boolean }) => {
    process.stdout.write(options.path ? `${bundledSkill}/\n` : await readFile(join(bundledSkill, 'SKILL.md'), 'utf8'))
  })

skill
  .command('update')
  .description('Replace installed copies of the skill that are older than this CLI; a custom description is kept')
  .option('--force', 'also replace copies that were edited by hand')
  .action(
    run(
      (options: { force?: boolean }) => updateSkills(Boolean(options.force)),
      view(text.skillUpdateSchema, value => text.skillUpdate(context, value))
    )
  )

const profileTopics = z.object({
  interests: z.array(z.object({ topic: z.string().optional(), level: z.enum(['high', 'interested', 'not_interested']) })),
  // A service before inferred interests sends none
  inferredInterests: z.array(z.object({ topic: z.string(), score: z.number() })).default([]),
  topics: z.array(z.object({ slug: z.string(), title: z.string(), section: z.string().nullable() })),
})

/**
 * Titles of the user's topics for the skill tail: strong interests first, subtopics before whole sections, then topics
 * inferred from their reading. An inferred topic already in the tail keeps its place, so a small change of weights
 * does not rewrite the file in every conversation.
 */
async function personalTopics(current: string[]): Promise<{ explicit: string[]; inferred: string[] }> {
  const profile = profileTopics.parse(await request('/api/knowledge/profile'))
  const bySlug = new Map(profile.topics.map(t => [t.slug, t]))

  const explicit = profile.interests
    .flatMap(i => {
      const topic = i.topic === undefined ? undefined : bySlug.get(i.topic)

      return topic && i.level !== 'not_interested' ? [{ title: topic.title, order: (i.level === 'high' ? 0 : 2) + (topic.section ? 0 : 1) }] : []
    })
    .sort((a, b) => a.order - b.order)
    .map(t => t.title)

  const inferred = [...profile.inferredInterests]
    .sort((a, b) => b.score - a.score)
    .flatMap(i => bySlug.get(i.topic)?.title ?? [])
    .filter(title => !explicit.includes(title))

  const kept = (title: string) => current.indexOf(tailTitle(title))
  const stable = [...inferred.filter(t => kept(t) >= 0).sort((a, b) => kept(a) - kept(b)), ...inferred.filter(t => kept(t) < 0)]

  return { explicit, inferred: stable }
}

function tailSource(topics: string[], inferred: string[]): TailSource | null {
  if (!topics.length) return null
  const fromReading = topics.filter(t => inferred.some(i => tailTitle(i) === t)).length

  return fromReading === 0 ? 'explicit' : fromReading === topics.length ? 'inferred' : 'mixed'
}

// A command the user can paste into their own terminal, where the file may be writable
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/**
 * Adds the user's topics to the description of the skill copy the agent loaded, so the agent reaches for it on them too.
 * Only a SKILL.md of this skill is changed; a copy that cannot be written is reported with a command for the user.
 */
async function personalizeSkill(o: { file: string }) {
  const given = resolve(o.file)
  const file = basename(given) === 'SKILL.md' ? given : join(given, 'SKILL.md')
  let text: string

  try {
    text = await readFile(file, 'utf8')
  } catch {
    throw new ApiError(`No skill file at ${file}`)
  }

  if (!/^---\r?\nname: giftsofprometheus\r?\n/.test(text)) throw new ApiError(`${file} is not the giftsofprometheus skill`)
  const line = skillDescription(text)

  if (!line) throw new ApiError(`${file} has no description line`)
  const { explicit, inferred } = await personalTopics(tailTitles(line))
  const topics = tailTopics([...explicit, ...inferred])
  const source = tailSource(topics, inferred)
  const next = personalDescription(line, topics)

  if (next === line) {
    await reportPersonalize(file, 'unchanged', topics.length, source)

    return { personalized: true, changed: false, path: file, topics, ...(source ? { source } : {}) }
  }

  const temporary = `${file}.${randomUUID()}.tmp`

  try {
    await writeFile(
      temporary,
      text.replace(/\r\n/g, '\n').replace(line, () => next),
      { mode: (await stat(file)).mode & 0o777, flag: 'wx' }
    )
    await rename(temporary, file)
  } catch (e) {
    await unlink(temporary).catch(() => {})
    await reportPersonalize(file, 'write_failed', topics.length, source)

    return {
      personalized: false,
      path: file,
      topics,
      ...(source ? { source } : {}),
      reason: e instanceof Error ? e.message : 'Write failed',
      command: `${cmd()} skill personalize --file ${shellQuote(file)}`,
    }
  }

  await reportPersonalize(file, 'written', topics.length, source)

  return { personalized: true, changed: true, path: file, topics, ...(source ? { source } : {}) }
}

skill
  .command('personalize')
  .description(
    "Add the user's topics (ten words at most), from their interests and then from their reading, to the description of the skill copy at --file; requires login"
  )
  .requiredOption('--file <path>', 'SKILL.md of the loaded skill, or its folder')
  .action(run(personalizeSkill, view(text.personalizeSchema, text.personalize)))

// The daily check runs after the command, so it never delays or breaks its output; doctor and skill report the same state themselves
let skipNotice = false

program.hook('preAction', (_, action) => {
  skipNotice = action.name() === 'doctor' || action.name() === 'skill' || action.parent?.name() === 'skill'
})

program
  .parseAsync()
  .then(() => (skipNotice ? undefined : updateNotice()))
  .catch(e => {
    if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version') return

    if (program.opts().json) console.log(JSON.stringify({ error: { message: e.message, status: 1 } }))
    else if (!e.code?.startsWith('commander.')) console.error(printable(String(e.message)))
    process.exitCode = 1
  })
