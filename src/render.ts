// Text a person reads in a terminal. With --json the CLI prints the service's JSON instead; that output is the agents' contract
import { z } from 'zod'

// Server text reaches a terminal: remove control characters so a response cannot inject ANSI or OSC escape sequences
// oxlint-disable-next-line no-control-regex -- matching control characters is the purpose of this function
export const printable = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')

/** Like printable, but keeps line breaks: talk summaries are Markdown paragraphs and lists */
const clean = (value: string) =>
  value
    .split(/\r?\n/)
    .map(line => printable(line).replace(/\*\*(.+?)\*\*/g, (_, inner: string) => bold(inner)))
    .join('\n')

const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb'

const style = (code: string) => (text: string) => (color ? `\u001b[${code}m${text}\u001b[0m` : text)

export const bold = style('1')

export const dim = style('2')

/** 75 s → 1:15, 3725 s → 1:02:05 */
export function clock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
  const two = (n: number) => String(n).padStart(2, '0')

  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`
}

const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`

const days = (seconds: number) => {
  const n = Math.round(seconds / 86_400)

  return n >= 1 ? `${n} day${n === 1 ? '' : 's'}` : `${Math.max(1, Math.round(seconds / 3600))} h`
}

const speaker = z.object({ name: z.string(), organization: z.string().nullish(), jobTitle: z.string().nullish() })

export const talkSchema = z.object({
  slug: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  speakers: z.array(speaker).default([]),
  topics: z.array(z.object({ title: z.string() })).default([]),
  event: z.object({ name: z.string() }).nullish(),
  durationMs: z.number().nullish(),
  publication: z.object({ url: z.string().nullish() }).nullish(),
  reason: z.string().nullish(),
  bookmarked: z.boolean().nullish(),
})

type Talk = z.infer<typeof talkSchema>

type Context = { launcher: string; base: string }

const talkUrl = (context: Context, slug: string) => `${context.base}/talks/${encodeURIComponent(slug)}`

const people = (talk: Talk) => talk.speakers.map(s => (s.organization ? `${s.name} (${s.organization})` : s.name)).join(', ')

const meta = (talk: Talk) => [people(talk), talk.event?.name, talk.durationMs ? minutes(talk.durationMs) : null].filter(Boolean).join(' · ')

/** The first paragraph of the summary is its TL;DR sentence */
const tldr = (talk: Talk) => talk.description?.split(/\n\s*\n/)[0]?.trim() ?? ''

function card(context: Context, talk: Talk, n: number) {
  const lines = [`${dim(`${n}.`)} ${bold(printable(talk.title))}${talk.bookmarked ? dim('  ★ saved') : ''}`]
  const details = meta(talk)

  if (details) lines.push(`   ${dim(printable(details))}`)

  if (tldr(talk)) lines.push(`   ${printable(tldr(talk))}`)

  if (talk.reason) lines.push(`   ${dim('Why:')} ${printable(talk.reason)}`)
  lines.push(`   ${dim(talkUrl(context, talk.slug))}`)

  return lines.join('\n')
}

const cards = (context: Context, items: Talk[]) => items.map((talk, i) => card(context, talk, i + 1)).join('\n\n')

const recId = z.uuid().optional()

/** A list with a recId attributes what the user opens or saves from it to that list */
const opened = (context: Context, id: string | undefined) =>
  id ? [`open one: ${context.launcher} talks content <slug> --rec-id ${id}`, `save one: ${context.launcher} favorites add <slug> --rec-id ${id}`] : []

export const pageSchema = z.object({ items: z.array(talkSchema), page: z.number(), totalPages: z.number(), total: z.number().optional(), recId })

/** A page of talks with a hint for the next one; `next` builds the command for a page number */
export function talkPage(context: Context, value: z.infer<typeof pageSchema>, next: (page: number) => string, empty: string) {
  if (!value.items.length) return empty
  const footer = [`Page ${value.page} of ${value.totalPages}${value.total === undefined ? '' : ` · ${value.total} talks`}`]

  if (value.page < value.totalPages) footer.push(`next: ${context.launcher} ${next(value.page + 1)}`)

  return [cards(context, value.items), '', dim(footer.join(' · ')), ...opened(context, value.recId).map(dim)].join('\n')
}

export const listSchema = z.object({ items: z.array(talkSchema), recId })

export function talkList(context: Context, value: z.infer<typeof listSchema>, empty: string) {
  return value.items.length ? [cards(context, value.items), '', ...opened(context, value.recId).map(dim)].join('\n').trimEnd() : empty
}

export function talkDetails(context: Context, talk: Talk) {
  const lines = [bold(printable(talk.title))]

  const details = [talk.event?.name, talk.durationMs ? minutes(talk.durationMs) : null].filter(Boolean).join(' · ')

  if (details) lines.push(dim(printable(details)))

  for (const s of talk.speakers) lines.push(dim(printable([s.name, s.jobTitle, s.organization].filter(Boolean).join(', '))))

  if (talk.topics.length) lines.push(dim(`Topics: ${printable(talk.topics.map(t => t.title).join(', '))}`))

  if (talk.description) lines.push('', clean(talk.description))
  lines.push('', `${dim('Page:')}  ${talkUrl(context, talk.slug)}`)

  if (talk.publication?.url) lines.push(`${dim('Video:')} ${printable(talk.publication.url)}`)

  return lines.join('\n')
}

const chapter = z.object({ title: z.string(), startMs: z.number() })

const contentBase = z.object({ title: z.string(), speakers: z.array(speaker).default([]), chapters: z.array(chapter).default([]) })

export const contentSchema = contentBase.extend({ transcript: z.array(z.object({ startMs: z.number(), text: z.string() })) })

export const outlineSchema = contentBase.extend({ transcriptSegments: z.number() })

/** Transcript lines with a heading where each chapter starts; an outline lists the chapters only */
export function transcript(value: z.infer<typeof contentSchema> | z.infer<typeof outlineSchema>) {
  const lines = [bold(printable(value.title))]
  const names = value.speakers.map(s => [s.name, s.jobTitle, s.organization].filter(Boolean).join(', '))

  if (names.length) lines.push(dim(printable(names.join('; '))))

  if (!('transcript' in value)) {
    lines.push('', ...value.chapters.map(c => `${dim(clock(c.startMs).padStart(8))}  ${printable(c.title)}`))
    lines.push('', dim(`${value.transcriptSegments} transcript segments`))

    return lines.join('\n')
  }

  const chapters = [...value.chapters].sort((a, b) => a.startMs - b.startMs)
  let next = 0

  for (const segment of value.transcript) {
    let heading: z.infer<typeof chapter> | undefined

    while (next < chapters.length && (chapters[next]?.startMs ?? Infinity) <= segment.startMs) heading = chapters[next++]

    if (heading) lines.push('', bold(`## ${printable(heading.title)}`))
    lines.push(`${dim(`[${clock(segment.startMs)}]`)} ${printable(segment.text)}`)
  }

  if (!value.transcript.length) lines.push('', 'No transcript segments in this range.')

  return lines.join('\n')
}

export const passagesSchema = z.object({
  recId,
  items: z.array(
    z.object({
      talk: talkSchema,
      passages: z.array(z.object({ startMs: z.number(), chapter: z.string().nullish(), text: z.string(), url: z.string() })),
    })
  ),
})

export function passages(context: Context, value: z.infer<typeof passagesSchema>) {
  if (!value.items.length) return 'Nothing found. Try other wording or another language.'

  return value.items
    .map((item, i) => {
      const lines = [`${dim(`${i + 1}.`)} ${bold(printable(item.talk.title))}`]

      if (meta(item.talk)) lines.push(`   ${dim(printable(meta(item.talk)))}`)

      for (const passage of item.passages) {
        lines.push('', `   ${dim(`[${clock(passage.startMs)}]${passage.chapter ? ` ${printable(passage.chapter)}` : ''}`)}`)
        lines.push(`   ${printable(passage.text)}`)
        lines.push(`   ${dim(printable(passage.url))}`)
      }

      return lines.join('\n')
    })
    .concat(value.recId ? [opened(context, value.recId).map(dim).join('\n')] : [])
    .join('\n\n')
}

const topicSchema = z.object({ slug: z.string(), title: z.string(), section: z.string().nullable() })

export const topicsSchema = z.object({ topics: z.array(topicSchema) })

/** Sections first, each followed by its subtopics */
export function topicTree(value: z.infer<typeof topicsSchema>) {
  const sections = value.topics.filter(t => !t.section)
  const orphans = value.topics.filter(t => t.section && !sections.some(s => s.slug === t.section))
  const row = (t: z.infer<typeof topicSchema>, indent: string) => `${indent}${printable(t.title)}  ${dim(printable(t.slug))}`
  const lines = []

  for (const section of sections) {
    lines.push(bold(row(section, '')))

    for (const topic of value.topics.filter(t => t.section === section.slug)) lines.push(row(topic, '  '))
    lines.push('')
  }

  lines.push(...orphans.map(t => row(t, '')))

  return lines.join('\n').trimEnd()
}

export const profileSchema = z.object({
  interests: z.array(z.object({ topic: z.string().optional(), level: z.enum(['high', 'interested', 'not_interested']) })),
  queryText: z.string(),
  topics: z.array(topicSchema).default([]),
})

const levelNames = { high: 'Very interested', interested: 'Interested', not_interested: 'Not interested' } as const

export function profile(value: z.infer<typeof profileSchema>) {
  const titles = new Map(value.topics.map(t => [t.slug, t.title]))
  const lines = [`${bold('Current task:')} ${value.queryText.trim() ? printable(value.queryText) : dim('not set')}`]

  for (const level of ['high', 'interested', 'not_interested'] as const) {
    const topics = value.interests.flatMap(i => (i.level === level && i.topic ? [printable(titles.get(i.topic) ?? i.topic)] : []))

    if (topics.length) lines.push('', bold(`${levelNames[level]}:`), ...topics.map(t => `  ${t}`))
  }

  if (!value.interests.length) lines.push('', dim('No interests yet. Set them with: profile update --interest <topic>=interested'))

  return lines.join('\n')
}

export const doctorSchema = z.object({
  base: z.string(),
  reachable: z.boolean(),
  authenticated: z.boolean(),
  configPath: z.string(),
  update: z.object({ installed: z.boolean(), current: z.string(), latest: z.string().nullable(), available: z.boolean(), command: z.string() }),
  skills: z.array(z.object({ path: z.string(), status: z.string(), version: z.string().nullable() })),
  nextStep: z.string().nullable(),
})

export function doctor(context: Context, value: z.infer<typeof doctorSchema>) {
  // ok, a problem, or plain information
  const row = (state: boolean | null, label: string, detail: string) => `${state === null ? '  ' : state ? 'ok' : '!!'}  ${label.padEnd(8)}${detail}`
  const cli = value.update.available ? `${value.update.current}; ${value.update.latest} is available: ${value.update.command}` : value.update.current

  const lines = [
    row(value.reachable, 'Service', `${value.base}${value.reachable ? '' : ' is unreachable'}`),
    row(value.authenticated, 'Account', value.authenticated ? 'signed in' : 'not signed in'),
    row(null, 'Session', value.configPath),
    row(!value.update.available, 'CLI', cli),
  ]

  if (!value.skills.length) lines.push(row(null, 'Skill', 'not installed in any agent'))

  for (const skill of value.skills) lines.push(row(skill.status !== 'outdated', 'Skill', `${skill.path}: ${skill.status}`))

  // The JSON names the installed command; a person gets the one that ran the CLI
  if (value.nextStep) lines.push('', `Next: ${value.reachable && !value.authenticated ? `run ${context.launcher} login` : value.nextStep}`)

  return lines.join('\n')
}

export const loginPromptSchema = z.object({ verificationUrl: z.string(), userCode: z.string(), expiresIn: z.number() })

export function loginPrompt(context: Context, value: z.infer<typeof loginPromptSchema>) {
  return [
    `Open ${value.verificationUrl}`,
    `and confirm the code ${bold(value.userCode)} within ${Math.ceil(value.expiresIn / 60)} min.`,
    `Then run: ${context.launcher} login --wait`,
  ].join('\n')
}

export const signedInSchema = z.object({ signedIn: z.literal(true), expiresIn: z.number().optional() })

export function signedIn(value: z.infer<typeof signedInSchema>) {
  return `Signed in.${value.expiresIn ? ` The session lasts ${days(value.expiresIn)}.` : ''}`
}

export const accountSchema = z.object({ email: z.string() })

export const account = (value: z.infer<typeof accountSchema>) => `Signed in as ${bold(printable(value.email))}`

// Onboarding cards are already shortened by the CLI: names and titles as strings, the summary's first paragraph
const briefSchema = z.object({
  slug: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  speakers: z.array(z.string()),
  event: z.string().nullable(),
  reason: z.string().optional(),
})

const fromBrief = (t: z.infer<typeof briefSchema>): Talk => ({
  slug: t.slug,
  title: t.title,
  description: t.summary,
  speakers: t.speakers.map(name => ({ name })),
  topics: [],
  event: t.event ? { name: t.event } : null,
  reason: t.reason,
})

export const deckSchema = z.object({ deck: z.array(briefSchema.extend({ n: z.number() })) })

export function deck(context: Context, value: z.infer<typeof deckSchema>) {
  if (!value.deck.length) return 'No talks for these topics. Try other topics.'

  return `${value.deck.map(t => card(context, fromBrief(t), t.n)).join('\n\n')}\n\n${dim(`Judge the talks by number: ${context.launcher} onboarding react 1=like 2=dislike`)}`
}

export const previewSchema = z.object({
  preview: z.array(briefSchema),
  answered: z.array(z.object({ n: z.number(), reaction: z.string().optional() })),
  unanswered: z.array(z.number()),
})

export function preview(context: Context, value: z.infer<typeof previewSchema>) {
  const lines = [
    bold('Recommendations for these answers:'),
    '',
    value.preview.length ? cards(context, value.preview.map(fromBrief)) : 'None yet: like a few more talks.',
    '',
  ]

  if (value.unanswered.length) lines.push(dim(`Not judged yet: ${value.unanswered.join(', ')}`))
  lines.push(dim(`Save to the account: ${context.launcher} onboarding finish`))

  return lines.join('\n')
}

export const skillUpdateSchema = z.object({
  version: z.string(),
  updated: z.array(z.object({ path: z.string(), from: z.string().nullable() })),
  unchanged: z.array(z.object({ path: z.string(), status: z.string() })),
})

export function skillUpdate(context: Context, value: z.infer<typeof skillUpdateSchema>) {
  const lines = value.updated.map(s => `Updated ${s.path}${s.from ? ` from ${s.from}` : ''} to ${value.version}`)

  for (const s of value.unchanged)
    lines.push(
      s.status === 'modified'
        ? `Kept ${s.path}: edited by hand; replace it with ${context.launcher} skill update --force`
        : `Kept ${s.path}: ${s.status === 'linked' ? 'linked to this CLI' : 'already current'}`
    )

  return lines.length ? lines.join('\n') : 'No installed copies of the skill found.'
}

export const personalizeSchema = z.object({
  personalized: z.boolean(),
  changed: z.boolean().optional(),
  path: z.string(),
  topics: z.array(z.string()),
  reason: z.string().optional(),
  command: z.string().optional(),
})

export function personalize(value: z.infer<typeof personalizeSchema>) {
  if (!value.personalized) return `Could not write ${value.path}: ${printable(value.reason ?? '')}\nRun in your terminal: ${value.command ?? ''}`
  const topics = value.topics.length ? value.topics.map(printable).join(', ') : 'no topics yet'

  return value.changed ? `Added your topics to ${value.path}: ${topics}` : `${value.path} already lists your topics: ${topics}`
}
