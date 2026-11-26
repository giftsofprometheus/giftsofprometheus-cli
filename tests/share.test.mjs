import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const executable = fileURLToPath(new URL('../dist/index.js', import.meta.url))

const page = {
  id: 'k7Fq3xN9a2Wb',
  url: 'http://x/shared/k7Fq3xN9a2Wb',
  status: 'draft',
  visibility: 'unlisted',
  hasPassword: false,
  title: 'T',
  talks: 1,
  warnings: [],
  updatedAt: '2026-11-26T00:00:00Z',
}

test('share commands call the account API with the answer, the access mode and the findings of a refused upload', async () => {
  const requests = []

  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => (body += chunk))
    request.on('end', () => {
      const parsed = body ? JSON.parse(body) : undefined
      requests.push({ path: request.url, method: request.method, body: parsed })
      response.setHeader('Content-Type', 'application/json')

      if (request.method === 'POST' && request.url === '/api/account/shared-answers' && parsed.markdown.includes('sk-')) {
        response.statusCode = 422
        response.end(JSON.stringify({ error: 'Секреты', code: 'shared_answer_secrets', findings: [{ kind: 'openai_key', excerpt: 'sk-pro…', line: 2 }] }))
      } else response.end(JSON.stringify({ ...page, previewUrl: page.url }))
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const config = await mkdtemp(join(tmpdir(), 'giftsofprometheus-share-'))

  const cli = args =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [executable, '--json', ...args], {
        env: {
          ...process.env,
          GIFTSOFPROMETHEUS_URL: base,
          XDG_CONFIG_HOME: config,
          GIFTSOFPROMETHEUS_NO_UPDATE_CHECK: '1',
          GIFTSOFPROMETHEUS_NO_BROWSER: '1',
          CLAUDECODE: '1',
        },
        timeout: 5000,
      })

      let output = ''
      child.stdout.on('data', chunk => (output += chunk))
      child.on('error', reject)
      child.on('close', code => resolve({ code, data: JSON.parse(output) }))
    })

  try {
    await mkdir(join(config, 'giftsofprometheus'), { mode: 0o700 })
    await writeFile(join(config, 'giftsofprometheus', 'credentials.json'), JSON.stringify({ base, token: 'secret' }), { mode: 0o600 })
    const file = join(config, 'answer.md')
    await writeFile(file, 'Ответ со ссылкой на [доклад](/talks/a)')

    const created = await cli(['share', 'create', '--title', 'T', '--question', 'Q', '--file', file])
    assert.equal(created.code, 0)
    assert.equal(created.data.previewUrl, page.url)
    assert.deepEqual(requests.at(-1), {
      path: '/api/account/shared-answers',
      method: 'POST',
      body: {
        title: 'T',
        question: 'Q',
        markdown: 'Ответ со ссылкой на [доклад](/talks/a)',
        sourceAgent: 'claude-code',
        cliVersion: requests.at(-1).body.cliVersion,
      },
    })

    await cli(['share', 'publish', page.id, '--visibility', 'password', '--password', 'long-enough'])
    assert.deepEqual(requests.at(-1), {
      path: `/api/account/shared-answers/${page.id}/publish`,
      method: 'POST',
      body: { visibility: 'password', password: 'long-enough' },
    })

    await cli(['share', 'visibility', page.id, 'public', '--confirm-public'])
    assert.deepEqual(requests.at(-1), {
      path: `/api/account/shared-answers/${page.id}/visibility`,
      method: 'PATCH',
      body: { visibility: 'public', confirmPublic: true },
    })

    await cli(['share', 'delete', page.id])
    assert.deepEqual(requests.at(-1), { path: `/api/account/shared-answers/${page.id}`, method: 'DELETE', body: undefined })

    const count = requests.length
    const badId = await cli(['share', 'delete', '../talks'])
    assert.equal(badId.code, 1)
    assert.equal(requests.length, count, 'a malformed id never reaches the service')

    const badMode = await cli(['share', 'visibility', page.id, 'everyone'])
    assert.equal(badMode.code, 1)

    await writeFile(file, 'строка\nключ sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
    const refused = await cli(['share', 'create', '--title', 'T', '--question', 'Q', '--file', file])
    assert.equal(refused.code, 1)
    assert.equal(refused.data.error.code, 'shared_answer_secrets')
    assert.deepEqual(refused.data.error.findings, [{ kind: 'openai_key', excerpt: 'sk-pro…', line: 2 }])
  } finally {
    server.close()
    await rm(config, { recursive: true, force: true })
  }
})
