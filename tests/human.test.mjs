import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
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
  speakers: [{ id: 1, name: 'Alfonso Graziano', organization: 'Nearform', jobTitle: null }],
  topics: [{ slug: 'evals', title: 'Evals и бенчмарки' }],
  durationMs: 1814000,
  event: { name: "AI Engineer World's Fair 2026", year: 2026 },
}

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
}

async function harness() {
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
      const child = spawn(process.execPath, [executable, ...args], {
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
    assert.match(get.stdout, /Topics: Evals и бенчмарки/)
    assert.match(get.stdout, /- Цикл с откатом — каждая/, 'Markdown bold is not printed as asterisks')
    assert.match(get.stdout, /Video: https:\/\/www\.youtube\.com\/watch\?v=x/)
    assert.match(get.stderr, /^Next: the full transcript/)

    const content = await h.cli(['talks', 'content', 'agents-building-agents'])
    assert.match(content.stdout, /## Введение\n\[1:00\] So today we will see\.\n\n## Архитектура\n\[2:00\] An agent is an LLM in a loop\.\n$/)

    assert.equal((await h.cli(['favorites', 'add', 'agents-building-agents'])).stdout, 'Saved agents-building-agents to favorites.\n')

    // Raw API access keeps JSON: it has no text form
    assert.equal(JSON.parse((await h.cli(['request', '/api/account/me'])).stdout).email, 'reader@example.com')

    assert.deepEqual(JSON.parse((await h.cli(['--json', 'whoami'])).stdout), { email: 'reader@example.com' })
    assert.equal(JSON.parse((await h.cli(['--json', 'talks', 'list'])).stdout).totalPages, 3)
  } finally {
    await h.close()
  }
})
