import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const executable = fileURLToPath(new URL('../dist/index.js', import.meta.url))

const content = {
  id: 2,
  title: 'Panel',
  speakers: [{ id: 7, name: 'Tanay Varshney', slug: 'tanay-varshney', organization: 'NVIDIA', jobTitle: null }],
  transcript: [
    { startMs: 0, text: 'intro' },
    { startMs: 89_000, text: 'before' },
    { startMs: 90_000, text: 'start' },
    { startMs: 149_999, text: 'inside' },
    { startMs: 150_000, text: 'end' },
  ],
  chapters: [{ id: 'c1', title: 'Глава', titleEn: 'Chapter', startMs: 0, endMs: 200_000 }],
  publication: null,
}

test('talks content cuts the transcript to a stretch or an outline, and ask explains its limits before any request', async () => {
  const requests = []

  const server = createServer((request, response) => {
    requests.push(request.url)
    response.setHeader('Content-Type', 'application/json')

    if (request.url === '/api/knowledge/talks/panel') response.end(JSON.stringify({ id: 2, slug: 'panel' }))
    else if (request.url === '/api/knowledge/talks/panel/content') response.end(JSON.stringify(content))
    else response.end(JSON.stringify({ recId: 'result', items: [] }))
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const config = await mkdtemp(join(tmpdir(), 'giftsofprometheus-range-'))

  const cli = args =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [executable, '--json', ...args], {
        env: {
          ...process.env,
          GIFTSOFPROMETHEUS_URL: base,
          XDG_CONFIG_HOME: config,
          GIFTSOFPROMETHEUS_NO_UPDATE_CHECK: '1',
          GIFTSOFPROMETHEUS_NO_BROWSER: '1',
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

    const whole = await cli(['talks', 'content', 'panel'])
    assert.deepEqual(whole.data, content)

    const stretch = await cli(['talks', 'content', 'panel', '--from', '1:30', '--to', '150'])
    assert.equal(stretch.code, 0)
    assert.deepEqual(
      stretch.data.transcript.map(s => s.text),
      ['start', 'inside']
    )
    assert.deepEqual(stretch.data.chapters, content.chapters)
    assert.deepEqual(stretch.data.speakers, content.speakers)

    const tail = await cli(['talks', 'content', 'panel', '--from', '0:02:30'])
    assert.deepEqual(
      tail.data.transcript.map(s => s.text),
      ['end']
    )

    const outline = await cli(['talks', 'content', 'panel', '--outline'])
    assert.equal(outline.data.transcript, undefined)
    assert.equal(outline.data.transcriptSegments, 5)
    assert.deepEqual(outline.data.chapters, content.chapters)

    const count = requests.length

    for (const [args, message] of [
      [['talks', 'content', 'panel', '--from', '1:3x'], /Invalid time "1:3x"/],
      [['talks', 'content', 'panel', '--from', '200', '--to', '100'], /--from must be earlier than --to/],
      [['ask', 'a', '--q', 'b', '--q', 'c', '--q', 'd'], /at most 3 formulations in total: the query and up to two --q\. Got 4; drop 1\./],
      [['ask', 'a', '--q', ' '], /Empty formulation/],
      [['ask', 'x'.repeat(201)], /longer than 200 characters \(201\)/],
    ]) {
      const result = await cli(args)
      assert.equal(result.code, 1)
      assert.match(result.data.error.message, message)
    }

    assert.equal(requests.length, count, 'invalid options are refused before any request')
  } finally {
    server.close()
    await rm(config, { recursive: true, force: true })
  }
})
