import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, symlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const executable = fileURLToPath(new URL('../dist/index.js', import.meta.url))

const talk = {
  id: 7,
  slug: 'agents-building-agents',
  title: 'Агенты создают агентов',
  description: 'Coding агент улучшает production-агента.\n\n- **Цикл с откатом** — каждая гипотеза в своей ветке.',
  publication: { platform: 'youtube', url: 'https://www.youtube.com/watch?v=x' },
  speakers: [{ id: 1, name: 'Alfonso Graziano', organization: 'Nearform', jobTitle: 'Staff Engineer' }],
  topics: [{ slug: 'evals', title: 'Evals и бенчмарки' }],
  durationMs: 1814000,
  event: { name: "AI Engineer World's Fair 2026", year: 2026 },
}

const recId = '6f1c2a40-1111-4a2b-9c3d-0123456789ab'

// DEL and C1 characters: JSON.stringify keeps them, and a terminal may interpret them
// oxlint-disable-next-line no-control-regex -- the tests assert that control characters are absent
const control = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/

const routes = {
  'POST /api/auth/device/code': { user_code: 'ABCD-1234', device_code: 'dc', interval: 1, expires_in: 30 },
  'POST /api/auth/device/token': { access_token: 'tok', expires_in: 2592000 },
  'GET /api/account/me': { email: 'reader@example.com' },
  'GET /api/knowledge/talks?page=1': { items: [{ ...talk, title: 'Агенты \u001b]52;c;x\u0007создают агентов' }], page: 1, totalPages: 3, total: 50 },
  'GET /api/knowledge/talks/agents-building-agents': talk,
  'POST /api/knowledge/talks/agents-building-agents/content': {
    id: 7,
    title: 'Agents Building Agents',
    speakers: talk.speakers,
    chapters: [
      { title: 'Введение', startMs: 0 },
      { title: 'Архитектура', startMs: 114000 },
    ],
    transcript: [
      { startMs: 60000, text: 'So today we will see.' },
      { startMs: 120000, text: 'An agent is an LLM in a loop.' },
    ],
  },
  'POST /api/knowledge/events': { accepted: 1 },
  'GET /api/knowledge/talks': { items: [], page: 1, totalPages: 1, total: 0 },
  'GET /api/knowledge/talks?q=-foo&page=1': { recId, items: [talk], page: 1, totalPages: 2, total: 30 },
  'GET /api/knowledge/favorites?page=1&limit=1': { items: [talk], page: 1, totalPages: 2, total: 2 },
  'GET /api/knowledge/feed': { recId, items: [{ ...talk, reason: 'Похоже на ваши интересы' }] },
  'GET /api/knowledge/raw': { text: 'a\u009b31mb' },
  'GET /api/knowledge/talks/evil': { ...talk, id: 8, slug: 'ev\u009b31mil' },
  'POST /api/knowledge/talks/renamed/content': { title: 'Renamed', speakers: [], chapters: [], segments: [] },
  'GET /api/knowledge/talks/renamed': { ...talk, id: 9, slug: 'renamed' },
  'GET /api/knowledge/talks?q=broken&page=1': { items: [{ ...talk, slug: '\ud800' }], page: 1, totalPages: 1 },
}

async function harness(program = executable) {
  const config = await mkdtemp(join(tmpdir(), 'giftsofprometheus-human-'))

  const server = createServer((request, response) => {
    const body = routes[`${request.method} ${request.url}`]
    response.statusCode = body ? 200 : 404
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(body ?? { error: 'not found' }))
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  const cli = args =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [program, ...args], {
        env: {
          ...process.env,
          GIFTSOFPROMETHEUS_URL: base,
          XDG_CONFIG_HOME: config,
          GIFTSOFPROMETHEUS_NO_UPDATE_CHECK: '1',
          GIFTSOFPROMETHEUS_NO_BROWSER: '1',
        },
        timeout: 10000,
      })

      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => (stdout += chunk))
      child.stderr.on('data', chunk => (stderr += chunk))
      child.on('error', reject)
      child.on('close', code => resolve({ code, stdout, stderr }))
    })

  return { cli, close: () => new Promise(resolve => server.close(resolve)) }
}

test('without --json commands print text for a person; with --json the same commands print JSON', async () => {
  const h = await harness()

  try {
    // The agent contract is unchanged: doctor names the plain command, talks content keeps its hint
    assert.equal(JSON.parse((await h.cli(['--json', 'doctor'])).stdout).nextStep, 'Run giftsofprometheus login')

    // The service takes the recId of an anonymous list only from the site, so a signed-out search does not offer it
    assert.doesNotMatch((await h.cli(['talks', 'search', '--', '-foo'])).stdout, /--rec-id/)
    const login = await h.cli(['login'])
    assert.equal(login.code, 0, login.stderr)
    assert.equal(login.stdout, 'Signed in. The session lasts 30 days.\n')
    assert.match(login.stderr, /confirm the code ABCD-1234/)

    assert.equal((await h.cli(['whoami'])).stdout, 'Signed in as reader@example.com\n')

    const list = await h.cli(['talks', 'list'])
    assert.match(list.stdout, /^1\. Агенты \]52;c;xсоздают агентов\n {3}Alfonso Graziano \(Nearform\) · AI Engineer World's Fair 2026 · 30 min\n/)
    assert.match(list.stdout, /\/talks\/agents-building-agents\n/)
    assert.match(list.stdout, /Page 1 of 3 · 50 talks · next: giftsofprometheus talks list --page 2\n$/)
    // oxlint-disable-next-line no-control-regex -- asserts that control characters from the service do not reach the terminal
    assert.doesNotMatch(list.stdout, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)

    const get = await h.cli(['talks', 'get', 'agents-building-agents'])
    assert.match(get.stdout, /Alfonso Graziano, Staff Engineer, Nearform/)
    assert.match(get.stdout, /Topics: Evals и бенчмарки/)
    assert.match(get.stdout, /- Цикл с откатом — каждая/, 'Markdown bold is not printed as asterisks')
    assert.match(get.stdout, /Video: https:\/\/www\.youtube\.com\/watch\?v=x/)
    assert.match(get.stderr, /^Next: the full transcript/)

    const content = await h.cli(['talks', 'content', 'agents-building-agents'])
    assert.match(content.stdout, /## Введение\n\[1:00\] So today we will see\.\n\n## Архитектура\n\[2:00\] An agent is an LLM in a loop\.\n$/)

    assert.equal((await h.cli(['favorites', 'add', 'agents-building-agents'])).stdout, 'Saved agents-building-agents to favorites.\n')

    const contentJson = await h.cli(['--json', 'talks', 'content', 'agents-building-agents'])
    assert.equal(
      contentJson.stderr,
      'Next: similar talks — giftsofprometheus talks similar agents-building-agents; save it if the user asks — giftsofprometheus favorites add agents-building-agents\n'
    )

    // Next-page commands keep the query after `--` and the page size; lists with a recId show how to pass it on
    const search = await h.cli(['talks', 'search', '--', '-foo'])
    assert.match(search.stdout, /next: giftsofprometheus talks search --page 2 -- '-foo'\n/)
    assert.match(search.stdout, new RegExp(`talks content <slug> --rec-id ${recId}\\n.*favorites add <slug> --rec-id ${recId}\\n$`))
    assert.match((await h.cli(['favorites', 'list', '--limit', '1'])).stdout, /next: giftsofprometheus favorites list --page 2 --limit '1'\n/)
    const feed = await h.cli(['feed'])
    assert.match(feed.stdout, /Why: Похоже на ваши интересы/)
    assert.match(feed.stdout, new RegExp(`--rec-id ${recId}`))

    // Server text never reaches the terminal with control characters: the JSON fallback escapes them, hints drop them
    const raw = await h.cli(['request', '/api/knowledge/raw'])
    assert.doesNotMatch(raw.stdout, control)
    assert.equal(JSON.parse(raw.stdout).text, 'a\u009b31mb')
    const evil = await h.cli(['talks', 'get', 'evil'])
    assert.doesNotMatch(evil.stdout + evil.stderr, control)

    // An unexpected shape, or one the text form cannot show, prints the JSON instead of failing
    const renamed = await h.cli(['talks', 'content', 'renamed'])
    assert.equal(renamed.code, 0)
    assert.deepEqual(JSON.parse(renamed.stdout).segments, [])
    const outline = await h.cli(['talks', 'content', 'renamed', '--outline'])
    assert.equal(outline.code, 0, outline.stderr)
    assert.deepEqual(JSON.parse(outline.stdout).segments, [])
    assert.equal((await h.cli(['--json', 'talks', 'content', 'renamed', '--outline'])).code, 1, '--json fails on it as before')
    const broken = await h.cli(['talks', 'search', 'broken'])
    assert.equal(broken.code, 0, broken.stderr)
    assert.equal(JSON.parse(broken.stdout).items.length, 1)

    // Raw API access keeps JSON: it has no text form
    assert.equal(JSON.parse((await h.cli(['request', '/api/account/me'])).stdout).email, 'reader@example.com')

    assert.deepEqual(JSON.parse((await h.cli(['--json', 'whoami'])).stdout), { email: 'reader@example.com' })
    assert.equal(JSON.parse((await h.cli(['--json', 'talks', 'list'])).stdout).totalPages, 3)
  } finally {
    await h.close()
  }
})

test('hints name the launcher that ran the CLI for a person; --json keeps the plain command', async () => {
  // The layout bunx leaves in its cache: <tmp>/bunx-<uid>-<package>/node_modules/@giftsofprometheus/cli
  const cache = await mkdtemp(join(tmpdir(), 'giftsofprometheus-launcher-'))
  const packageRoot = join(cache, 'bunx-1000-@giftsofprometheus', 'cli@latest', 'node_modules', '@giftsofprometheus', 'cli')
  const source = fileURLToPath(new URL('../', import.meta.url))
  await mkdir(packageRoot, { recursive: true })

  for (const entry of ['dist', 'skills', 'package.json']) await cp(join(source, entry), join(packageRoot, entry), { recursive: true })
  await symlink(join(source, 'node_modules'), join(packageRoot, 'node_modules'))
  const h = await harness(join(packageRoot, 'dist', 'index.js'))

  try {
    assert.match(
      (await h.cli(['talks', 'get', 'agents-building-agents'])).stderr,
      /^Next: the full transcript — bunx @giftsofprometheus\/cli talks content agents-building-agents/
    )
    assert.equal(
      (await h.cli(['--json', 'talks', 'get', 'agents-building-agents'])).stderr,
      'Next: the full transcript — giftsofprometheus talks content agents-building-agents (asks you to sign in in the browser first)\n'
    )
  } finally {
    await h.close()
  }
})
