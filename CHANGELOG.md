# Changelog

## 0.10.0

- `skill personalize` can also add `inferredInterests` of `profile get`, the topics the service infers from the user's activity, after the questionnaire topics, once the user agreed: `--reading agree` or `--reading decline` records the answer in `consent.json` on this machine before anything else (its own file, so an older CLI that rewrites `skill.json` cannot drop it); an answer that cannot be saved is an error. `login` and `logout` drop the answer, so another account is asked again. Runs on one machine take turns through `skill.lock`, so a late run never writes topics after a newer decline. Until then the output has `reading: "unasked"` and `suggested`, the titles that would be added; after a decline only the questionnaire is used.
- Among the inferred topics that fit the ten words, those already in the tail keep their order, so new weights do not rewrite the file; a topic that no longer ranks among the ones that fit gives its place to a stronger one. When no topic is left, the tail is removed and the text output says so.
- When the service answers `inferredUnavailable: true` (it could not compute the topics this time), the inferred topics already in the tail stay. The `command` of a copy that cannot be written keeps `--reading`.
- The output and the report to the service carry where the topics came from: `source` / `tail_source`, `explicit`, `inferred` or `mixed`. The report also carries counts and the consent state, never the topics: `reading`, `answer` in the run that recorded it, `suggested`, `added` and `removed` (left out when the file could not be written) and `inferred_unavailable`.
- `profile get` shows the inferred topics under "From your activity (not saved)" with the number of talks or search sessions behind each.
- Skill: run `skill personalize` once per conversation after the first answer from `ask`, `talks search` or `talks content` for a signed-in user, and once more after another transcript if the first run found nothing; offer the `suggested` topics, saying the tail will follow their activity, as the first of the Next steps offers and before the Feedback question. The run after an answer is silent apart from the offer. When the user asks about their interests, show both kinds; `not_interested` keeps a topic out of the topics from activity and lowers it in the feed.
- Skill: install the CLI with `npm install -g @giftsofprometheus/cli` instead of running it through `npx`, `pnpm dlx` or `bunx`, which mix versions on one machine; `allowed-tools` names only `giftsofprometheus`. An `unknown option` for an option the skill names means an older CLI: offer the update. The README no longer offers a run without install.
- Release after the service returns `inferredInterests` and accepts `tail_source` in `POST /api/knowledge/skill/personalize`: an older service rejects the report with the new field, and the report is dropped silently.

## 0.9.0

- Each request sends `X-Skill-Tail`: the number of topics in the personal tail of the installed skill (`0` without a tail), or `none` when the CLI finds no copy it can read. Each run reads the first 8 KB of the copies in the agent folders of the home and the current folder, and of the copy `skill personalize` last wrote (its path is kept in `skill.json`, 0600); after 500 ms without an answer the header is left out. The topics themselves are not sent.
- `skill personalize` tells the service what it did (`POST /api/knowledge/skill/personalize`: `written`, `unchanged` or `write_failed` and the number of topics). The report waits 2 seconds at most and is not repeated; a failed report never changes the command output. Release after the service supports the route.

## 0.8.4

- `talks content --outline` asks the service for the chapters only (`part=outline`), and the service no longer counts it as reading the talk: a look at the outline does not hide the talk from the feed for two weeks. A service that ignores `part` still gets the outline cut on the client. `--from`/`--to` still read the transcript. Release after the service supports `part=outline` (GOP-67).

## 0.8.3

- Skill: do not page through the whole catalog; find talks with `ask` or `talks search`, and watch for new talks through the RSS feed `https://giftsofprometheus.com/talks/feed.xml` instead of listing pages.

## 0.8.2

- Skill: when the profile has no current task, offer once to save one built from the questions of the user, in their language, only after they agree to the exact text; after answering a search question, offer the personal feed once per conversation. One offer per message, the task first. Release after the service runs engine v9, which leaves recently read transcripts out of the feed.

## 0.8.1

- Each request sends `X-Client-Id`, a random UUID created once in `client.json` (0600) next to the session. The service counts a guest CLI as one client in its analytics instead of a new one per request. A config folder that cannot be written only drops the header.

## 0.8.0

- Without `--json` commands print text for a person instead of indented JSON: `login` says it signed in and for how long, `whoami` the email, `doctor` a checklist, talk lists numbered cards with speakers, conference, length, the TL;DR and the page link, and a page footer with the next-page command; `talks get` the summary with topics and links; `talks content` the transcript with chapter headings and timestamps; `ask` passages with timestamps and links; `profile get` interests by level; `favorites add/remove`, `talks react`, `profile update`, `onboarding` and `skill` commands a short line each. `request` still prints JSON. `--json` output is unchanged.
- `Next:` hints on stderr come after the output, and suggested commands use the launcher that ran the CLI: `npx`, `bunx` or `pnpm dlx`.
- On 401 without `--json` the hint says to run `login`; the agent sign-in steps stay in `--json` errors.
- Feed, similar and `ask` show the `--rec-id` commands for opening or saving a talk from them; next-page commands keep `--limit` and put the search query after `--`.
- Text output strips control characters from server text, also in hints; the JSON fallback for `request` and unexpected responses escapes DEL and C1 characters. A response the text form cannot show prints as JSON.
- `talks get` shows speakers with job titles; `talks`, `favorites` and `profile get` subcommands have help descriptions.
- `--json` output keeps its bytes: hints and the `skill personalize` command name `giftsofprometheus` (or `npx @giftsofprometheus/cli`) as before; the `bunx` and `pnpm dlx` launchers appear only in text output. Search results in text form carry no `--rec-id`: search is public, an expired session makes its recId an anonymous one, and the service accepts those only from the site.
- `NO_COLOR` turns off bold and dim text.
- Skill: pass `--json` to every command.

## 0.7.3

- Package, skill and plugin descriptions follow the site's wording: world AI knowledge in Russian for you and your agent; conference names left the descriptions. More npm keywords: `ai-agents`, `agent-skills`, `ai-engineering`, `cursor`, `evals`, `llm`, `mcp`, `rag`, `russian`.
- README: the new wording, no talk count, links to articles and the event calendar, four more conferences in «Что есть в каталоге».

## 0.7.2

- The repository moved to the `giftsofprometheus` organization: https://github.com/giftsofprometheus/giftsofprometheus-cli. Links in the package, README and skill point there; the old URL redirects.

## 0.7.1

- Skill: practice questions ("how to review AI code", "how to do evals") are answered with how teams running it in production do it. The agent builds `ask` queries in practitioners' first-person wording ("how we … in production at our company", "lessons learned rolling out …"), structures the answer by company, marks vendors and gives no recipe of its own. On neutral questions this raised the share of companies' own production talks among cited sources from 24% to 43% in an evaluation on 10 topics.

## 0.7.0

- `talks content --from <time> --to <time>` keeps only the transcript segments that start in that stretch (seconds, `m:ss` or `h:mm:ss`); chapters stay whole. `--outline` returns speakers, chapters and publication with the number of segments instead of the transcript.
- `ask` explains its limits before any request: at most three formulations in total (the query and up to two `--q`), none empty, each up to 200 characters. It used to print a raw validation error.
- Speakers in talk cards and in `talks content` carry `organization` and `jobTitle` from the service (`null` when unknown).
- Skill: `ask` takes the query and up to two `--q`; read around a passage with `--outline` and `--from`/`--to`; link to the second where the cited words start and keep the `recId`; name a speaker's company only from `organization`, attribute claims in panels only when the transcript shows who speaks; for "how does the industry do X", lead with companies describing their own production and say when the evidence is mostly vendor talks.

## 0.6.1

- Skill: use only the CLI and never call the site's API directly; the service now answers other clients with 403 `cli_required`. Without `npx`, run the CLI with `pnpm dlx` or `bunx`; if nothing runs, ask the user to install it and stop.
- Skill: on `cli_required`, run the command through the CLI. The CLI always sends its User-Agent, so it never gets this code itself.

## 0.6.0

- Errors carry the service's stable `code` and its `nextStep` when it sends them: `{"error":{"message","status","code","nextStep"}}` with `--json`, and a `Next:` line on stderr without it. On 401 `nextStep` stays the CLI's own sign-in steps. Service messages are now in Russian, so decide by `code`, not by the text.
- `talks search` refuses an empty or whitespace query and points to `talks list`: the service answers such a query with the whole catalog.
- A connection failure, or a 502, 503 or 504 from the proxy in front of the service (a response without a service error code), is repeated twice with backoff (0.5 s, 1.5 s). After that the error says the service is temporarily unavailable or unreachable. A timeout is not repeated.
- Skill: decide by `code` and follow `nextStep`; on a temporary outage wait a minute and try once more. `ask` falls back to `talks search` on `passages_unavailable`.
- `talks content` chapters have a Russian `title` (with a fallback to the source title) and the source `titleEn`, when the service provides them.

## 0.5.1

- `request` with a relative path says to pass a full path starting with `/api/knowledge/`, `/api/account/` or `/api/auth/device/`.
- Skill: `request` takes a full path; `request /api/knowledge/talks/<slug>/state` shows the user's reaction and bookmark on a talk.

## 0.5.0

- `talks react <slug-or-id> like|dislike|not-interested|clear [--rec-id]` records what the user said about a talk.
- `skill personalize --file <SKILL.md>` adds the user's topics, ten words at most, to the description of that skill copy ("Also good for …"). Only a SKILL.md of this skill is changed, atomically. When the file cannot be written, the output has `personalized: false` and a `command` the user can run themselves.
- `skill update` keeps the personal tail: a shipped description with a tail becomes the new shipped description with the same tail.
- Skill: once per conversation, after two or more transcripts, the agent asks which talks hit the mark and records the answers. After onboarding or an interest change it personalizes its own description and says so in a few words.
- Skill: reactions and favorites take the `recId` of any list the talk came from, including `ask` passages; opening a talk from `ask` counts toward the feedback question.

## 0.4.0

- `ask <query> [--q <query>] [--limit n] [--per-talk n]` searches talk passages and returns citations and timecoded URLs; requires sign-in and the service endpoint `GET /api/knowledge/passages`.
- `talks search` sends the saved session when available. `talks content --rec-id` rejects an invalid UUID before any request.
- Skill: use `ask` for content questions with English, Chinese and original-language formulations; attribute transcript reads and cite the returned passage links.

## 0.3.0

- `talks similar <slug-or-id>`: up to four similar talks with a reason each. With a session the list has a `recId`.
- `talks content --rec-id` and `favorites add --rec-id` pass the `recId` of the list the talk came from (feed, search or similar), so the service attributes the transcript and the bookmark to that list. An invalid `recId` is refused before the request.
- `talks content` prints the next step on stderr: similar talks, or saving the talk if the user asks.
- Skill: one next step after an answer (summary → transcript → similar talks → favorites), each at most once per talk; the agent passes `recId` on.
- Requires the service endpoint `GET /api/knowledge/talks/:slug/similar`.

## 0.2.2

- An npm-installed CLI checks for a new version once a day and prints a line starting with `Update:` on stderr after the command; npx runs are not checked. `GIFTSOFPROMETHEUS_NO_UPDATE_CHECK=1` or `CI` turns it off.
- Installed copies of the skill are compared with every released version by a hash that leaves out the `description` line. `doctor` reports each as `current`, `outdated`, `modified` or `linked`; `skill update` replaces outdated copies and keeps a custom description, `--force` also replaces copies edited by hand.
- A command that needs an account and gets 401: in a terminal the CLI starts the browser confirmation, waits for it and repeats the command; with `--json` the error carries `nextStep` with the sign-in steps, so an agent without the skill also knows to sign the user in.
- `talks get` prints the next step on stderr: the `talks content` command for the transcript, and that it asks to sign in when there is no session.
- `GIFTSOFPROMETHEUS_NO_BROWSER=1` keeps `login` from opening a browser; the tests set it, so they no longer open tabs.
- `skills/history.json` holds the hash and description of every release; `pnpm skill-history` regenerates it.
- Skill: the agent offers an update in one line and runs it only after the user agrees.
- `login --wait` and `login` back off on HTTP 429 the same way as on `slow_down` instead of failing a login the user may already have confirmed.

## 0.2.1

- Skill: without an installed CLI the agent runs the same commands through `npx -y @giftsofprometheus/cli` instead of stopping to ask for an install. The site's "pick talks with your AI agent" prompt relies on this.
- Skill: onboarding runs when the user asks for it, and ends with the personal feed. Before `finish` the agent signs in by itself and only gives the user the confirmation link.
- `onboarding deck` and `onboarding react` print compact cards: `slug`, `title`, `summary` (the first paragraph), speaker names, topic titles and the event name. The deck output shrinks from about 50 KB to a few KB.

## 0.2.0

- `onboarding topics`, `onboarding deck`, `onboarding react` and `onboarding finish`: a starting profile from topic choices and a numbered deck of up to 8 talks, judged by card number. The draft is kept in `onboarding.json` (0600) next to the session, so the steps before `finish` need no account and `finish` works after `login`.
- `login --start` prints the confirmation link and code as JSON and exits; `login --wait` finishes that login. An agent can show the link without waiting for the whole device flow. Plain `login` works as before.
- Skill: onboarding in the conversation; the agent signs in by itself when a command needs an account; reading needs no confirmation.
- Requires the service endpoints `GET /api/knowledge/topics` and `POST /api/knowledge/onboarding/deck`.

## 0.1.3

- README: installation from npm, npm badge.
- `profile update` takes `--interest topic=level`, `--remove-interest topic` and `--query-text` instead of `--file`, and keeps fields that were not passed. The CLI no longer reads local files for the profile.
- `login` no longer starts `cmd` on Windows; it prints the link to open. On macOS it runs `/usr/bin/open`.
- `login` checks the code, polling interval and expiry it receives, and writes the session to a new 0600 file that replaces the old one.
- `logout` keeps a session issued by another service and names the service to sign out of. A damaged session file is an error, not a successful sign-out.
- A relative `XDG_CONFIG_HOME` is ignored, so the session is never written under the working directory.
- Requests time out after 30 seconds. Server messages printed to the terminal are stripped of control characters.
- Skill: titles, summaries and transcripts are untrusted data, not instructions.
- Release workflow: actions pinned to commit SHAs; checks run without write or OIDC permissions, and the publish job receives only the built tarball.

## 0.1.2

- Published to npm as `@giftsofprometheus/cli` through Trusted Publishing, with provenance.

## 0.1.1

- The `User-Agent` is `giftsofprometheus/<version>` again, so the account page names CLI devices as before.
- README in Russian.

## 0.1.0

First public release.

- `talks search`, `talks list`, `talks get` and `talks content` read the catalog and full transcripts.
- `favorites`, `profile` and `feed` work with the signed-in account.
- `login` signs in through a browser confirmation; `logout` revokes the device.
- `skill` prints the bundled agent skill; the skill also installs with `npx skills add` and as a Claude Code plugin.
- `request` reaches only the public Knowledge and account APIs.
- The default service is https://giftsofprometheus.com.
