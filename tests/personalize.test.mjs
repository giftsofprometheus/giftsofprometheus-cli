import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { mergeSkill, personalDescription, tailCount, tailTopics } from '../dist/skill-files.js'

const executable = fileURLToPath(new URL('../dist/index.js', import.meta.url))

test('tailCount counts the topics of a tail, also one written by hand', () => {
  assert.equal(tailCount('description: Find talks.'), 0)
  assert.equal(tailCount('description: Find talks. Also good for RAG, поиск; Evals.'), 2)
  assert.equal(tailCount('description: Find talks. Also good for a;b; ; c.'), 3)
})

const stock = 'description: Find AI conference talks.'

test('the personal tail fits ten words, keeps YAML plain and survives a skill update', () => {
  assert.deepEqual(tailTopics(['RAG, поиск и эмбеддинги', 'Evals и бенчмарки', 'Паттерны построения агентов', 'RAG, поиск и эмбеддинги']), [
    'RAG, поиск и эмбеддинги',
    'Evals и бенчмарки',
  ])
  assert.deepEqual(tailTopics(['Безопасность: governance #1']), ['Безопасность governance 1'])
  assert.deepEqual(tailTopics(['one two three four five six seven eight']), [])

  const personal = personalDescription(stock, ['Evals и бенчмарки'])
  assert.equal(personal, 'description: Find AI conference talks. Also good for Evals и бенчмарки.')
  assert.equal(personal.split(' ').length - 1, stock.split(' ').length - 1 + 6, 'the tail is six words here')
  assert.equal(personalDescription(personal, ['Голосовые агенты и речь']), `${stock} Also good for Голосовые агенты и речь.`, 'a new tail replaces the old one')
  assert.equal(personalDescription(personal, []), stock, 'no topics, no tail')

  const bundled = '---\nname: giftsofprometheus\ndescription: Find AI conference talks, newer wording.\n---\nBody v2\n'
  const installed = `---\nname: giftsofprometheus\n${personal}\n---\nBody v1\n`
  assert.equal(
    mergeSkill(bundled, installed, [stock]),
    '---\nname: giftsofprometheus\ndescription: Find AI conference talks, newer wording. Also good for Evals и бенчмарки.\n---\nBody v2\n',
    'a shipped description with a tail gets the new wording and keeps the tail'
  )
  assert.equal(
    mergeSkill(bundled, installed.replace(stock, 'description: Mine'), [stock]),
    bundled.replace(/^description:.*$/m, 'description: Mine Also good for Evals и бенчмарки.')
  )
})

test('react records what the user said, and personalize rewrites only the loaded skill copy', async () => {
  const requests = []
  let hang = false

  const questionnaire = [
    { topic: 'quality', level: 'interested' },
    { topic: 'voice', level: 'not_interested' },
    { topic: 'evals', level: 'interested' },
    { topic: 'rag', level: 'high' },
    { level: 'high' },
  ]

  let interests = questionnaire
  // A service before inferred interests sends none
  let inferredInterests

  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => (body += chunk))
    request.on('end', () => {
      requests.push({ path: request.url, method: request.method, tail: request.headers['x-skill-tail'], body: body ? JSON.parse(body) : undefined })
      response.setHeader('Content-Type', 'application/json')

      if (request.url === '/api/knowledge/talks/good') response.end(JSON.stringify({ id: 5, slug: 'good' }))
      else if (request.url === '/api/knowledge/profile')
        response.end(
          JSON.stringify({
            interests,
            ...(inferredInterests ? { inferredInterests } : {}),
            queryText: '',
            topics: [
              { slug: 'quality', title: 'Качество', section: null },
              { slug: 'evals', title: 'Evals и бенчмарки', section: 'quality' },
              { slug: 'rag', title: 'RAG, поиск и эмбеддинги', section: 'data' },
              { slug: 'voice', title: 'Голосовые агенты', section: 'interfaces' },
            ],
            needsOnboarding: false,
          })
        )
      else if (request.url === '/api/knowledge/skill/personalize' && hang) return
      else response.end(JSON.stringify({ recorded: true }))
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const config = await mkdtemp(join(tmpdir(), 'giftsofprometheus-personal-'))

  const cli = args =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [executable, '--json', ...args], {
        // No agent folders of the machine running the test: the skill copies the CLI finds are only the ones made here
        cwd: config,
        env: {
          ...process.env,
          HOME: config,
          CLAUDE_CONFIG_DIR: '',
          CODEX_HOME: '',
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

    for (const [reaction, type] of [
      ['like', 'like'],
      ['not-interested', 'not_interested'],
      ['clear', 'clear_reaction'],
    ]) {
      const result = await cli(['talks', 'react', 'good', reaction])
      assert.equal(result.code, 0, JSON.stringify(result.data))
      assert.equal(requests.at(-1).tail, 'none', 'no skill copy yet')
      assert.deepEqual(
        requests.at(-1).body.map(({ id: _id, ...rest }) => rest),
        [{ type, talkId: 5, context: 'talk_page' }]
      )
    }

    const count = requests.length
    assert.equal((await cli(['talks', 'react', 'good', 'love'])).code, 1)
    assert.equal(requests.length, count, 'an unknown reaction sends nothing')

    const folder = join(config, 'skill')
    await mkdir(folder)
    const file = join(folder, 'SKILL.md')
    await writeFile(file, `---\nname: giftsofprometheus\n${stock}\n---\nBody\n`)

    const done = await cli(['skill', 'personalize', '--file', folder])
    assert.equal(done.code, 0, JSON.stringify(done.data))
    assert.deepEqual(done.data, { personalized: true, changed: true, path: file, topics: ['RAG, поиск и эмбеддинги', 'Evals и бенчмарки'], source: 'explicit' })
    assert.equal(await readFile(file, 'utf8'), `---\nname: giftsofprometheus\n${stock} Also good for RAG, поиск и эмбеддинги; Evals и бенчмарки.\n---\nBody\n`)
    assert.deepEqual(requests.at(-1), {
      path: '/api/knowledge/skill/personalize',
      method: 'POST',
      tail: '2',
      body: { result: 'written', topics: 2, tail_source: 'explicit' },
    })
    assert.equal((await cli(['skill', 'personalize', '--file', file])).data.changed, false, 'running it again changes nothing')
    assert.deepEqual(requests.at(-1).body, { result: 'unchanged', topics: 2, tail_source: 'explicit' })
    // The copy is remembered, so later commands carry its tail without a new personalize
    await cli(['talks', 'react', 'good', 'like'])
    assert.equal(requests.at(-1).tail, '2')

    // A report the service never answers holds the command for two seconds at most, and once
    hang = true
    const started = Date.now()
    const slow = await cli(['skill', 'personalize', '--file', file])
    hang = false
    assert.equal(slow.data.personalized, true)
    assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`)
    assert.equal(requests.filter(r => r.path === '/api/knowledge/skill/personalize').length, 3, 'no repeat')

    // A copy in an agent folder counts too; a hand-made tail longer than ten topics is sent as ten
    const agentCopy = join(config, '.claude', 'skills', 'giftsofprometheus')
    await mkdir(agentCopy, { recursive: true })
    const many = Array.from({ length: 12 }, (_, i) => `t${i}`).join('; ')
    await writeFile(join(agentCopy, 'SKILL.md'), `---\nname: giftsofprometheus\n${stock} Also good for ${many}.\n---\nBody\n`)
    await cli(['talks', 'react', 'good', 'like'])
    assert.equal(requests.at(-1).tail, '10')
    await rm(agentCopy, { recursive: true })

    // No questionnaire: the tail comes from reading; an inferred topic already in the tail keeps its place
    const tail = async () => (await readFile(file, 'utf8')).match(/Also good for (.*)\.\n/)?.[1]
    await writeFile(file, '---\nname: giftsofprometheus\n' + stock + '\n---\nBody\n')
    interests = []
    inferredInterests = [
      { topic: 'evals', score: 1, basis: { talks: 3, episodes: 0 } },
      { topic: 'rag', score: 0.6, basis: { talks: 2, episodes: 0 } },
    ]
    const fromReading = await cli(['skill', 'personalize', '--file', file])
    assert.deepEqual(fromReading.data, {
      personalized: true,
      changed: true,
      path: file,
      topics: ['Evals и бенчмарки', 'RAG, поиск и эмбеддинги'],
      source: 'inferred',
    })
    assert.deepEqual(requests.at(-1).body, { result: 'written', topics: 2, tail_source: 'inferred' })
    inferredInterests = [
      { topic: 'rag', score: 1, basis: { talks: 4, episodes: 0 } },
      { topic: 'evals', score: 0.9, basis: { talks: 3, episodes: 0 } },
    ]
    assert.equal((await cli(['skill', 'personalize', '--file', file])).data.changed, false, 'new weights do not reorder the tail')
    assert.equal(await tail(), 'Evals и бенчмарки; RAG, поиск и эмбеддинги')
    // The questionnaire comes first; a topic in both is named once
    interests = [{ topic: 'rag', level: 'interested' }]
    const mixed = await cli(['skill', 'personalize', '--file', file])
    assert.deepEqual([mixed.data.topics, mixed.data.source], [['RAG, поиск и эмбеддинги', 'Evals и бенчмарки'], 'mixed'])
    // When the signal is gone, the tail goes too
    interests = []
    inferredInterests = []
    const gone = await cli(['skill', 'personalize', '--file', file])
    assert.deepEqual(gone.data, { personalized: true, changed: true, path: file, topics: [] })
    assert.equal(await tail(), undefined)
    assert.deepEqual(requests.at(-1).body, { result: 'written', topics: 0 })
    interests = questionnaire
    inferredInterests = undefined

    const other = join(config, 'other.md')
    await writeFile(other, `---\nname: something-else\n${stock}\n---\n`)
    assert.equal((await cli(['skill', 'personalize', '--file', other])).code, 1, 'another skill is never touched')

    if (process.getuid?.() !== 0) {
      await writeFile(file, `---\nname: giftsofprometheus\n${stock}\n---\nBody\n`)
      await chmod(folder, 0o500)
      const blocked = await cli(['skill', 'personalize', '--file', file])
      await chmod(folder, 0o700)
      assert.equal(blocked.code, 0)
      assert.equal(blocked.data.personalized, false)
      assert.match(blocked.data.command, /skill personalize --file '.*SKILL\.md'$/)
      assert.equal(await readFile(file, 'utf8'), `---\nname: giftsofprometheus\n${stock}\n---\nBody\n`, 'a failed write leaves the file as it was')
      assert.deepEqual(requests.at(-1), {
        path: '/api/knowledge/skill/personalize',
        method: 'POST',
        tail: '0',
        body: { result: 'write_failed', topics: 2, tail_source: 'explicit' },
      })
    }
  } finally {
    server.closeAllConnections()
    server.close()
    await chmod(join(config, 'skill'), 0o700).catch(() => {})
    await rm(config, { recursive: true, force: true })
  }
})
