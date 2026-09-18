# @yuiseki/cosensecli

Your Cosense projects, readable by an assistant.

[Cosense](https://scrapbox.io) (formerly Scrapbox) is a wiki whose pages link
into a graph, and a page there often means little on its own: the context lives
in what links to it. `cosensecli` runs as an [MCP server](#mcp-server) so an
assistant can read a page, walk its neighbourhood, and search a project without
you translating each question into a command.

It reads. It does not write. See [what it will not do](#what-it-will-not-do).

## How it relates to the cosense CLI

This package holds no knowledge of the Cosense API. All of it is in
[`@helpfeel/cosense-cli`](https://github.com/helpfeel/cosense-cli), which is
Helpfeel's own, and which keeps that knowledge current as Cosense changes.
`cosensecli` depends on it, runs it as a child process, and passes its output
back as the tool result.

That works because the `cosense` CLI already formats for a reader rather than a
parser. `browsePage` returns Markdown carrying the page metadata, the icons, a
per-author summary of who wrote which lines, any Infobox, the body with its
attachments expanded, and the related page titles. A JSON dump of the same page
would say less. So the wrapper is thin on purpose, and the work it does is
choosing a command, building its arguments, and staying out of the way.

The `cosense` CLI is designed as a harness for an
[Agent Skill](https://github.com/helpfeel/cosense-cli/tree/main/skills/cosense),
where the Skill carries the domain knowledge and the CLI carries the mechanics.
An MCP client gets no Skill, so what a Skill would have said has to travel in
the tool descriptions instead. That is the one place this package adds rather
than forwards. See [ADR 004](docs/ADR/004-descriptions-carry-the-wisdom.md).

## A default project

The `cosense` CLI has no current project: every command names one, which is
right for a command line. Over MCP it is not, because naming the project in
every sentence is the plumbing an assistant was meant to absorb.

```bash
cosensecli config set default-project yuiseki
```

With that set, "what did I write about maps" is answerable as asked. Every tool
still takes `project_url`, and a given one wins, so other projects stay
reachable through the same connector. The page tools also take a bare `title`
once there is a default, since search answers in titles.

A bare name means scrapbox.io. A URL is taken as given, so another instance
works too, and a page URL is refused rather than stored, since defaulting to a
page would answer every question about that one page. The value is normalised
before it is written, so a mistake is an error at the moment you make it.

```bash
cosensecli config get default-project    # the value on stdout, its origin on stderr
```

| | |
| --- | --- |
| `~/.config/cosensecli/projects.json` | where it is stored, 0600 |
| `COSENSECLI_DEFAULT_PROJECT` | overrides the file |

The environment winning is what lets one service unit point at one project
without changing what the same user gets at a terminal. `config set` says so
when the variable is set, rather than leaving you to wonder why what you just
set is not what is being used.

See [ADR 005](docs/ADR/005-a-default-project.md).

## Install

```bash
npm i -g @yuiseki/cosensecli
```

Needs Node 24 or newer, which is what the CLI underneath declares.

## Getting started

```bash
cosensecli doctor       # is the CLI underneath usable, and am I logged in?
cosensecli --mcp-server
```

Reading a page or searching is live, every time. A public project reads with no
credentials at all:

```bash
cosensecli doctor
# cosense binary: .../node_modules/@helpfeel/cosense-cli/bin/cosense
# authenticated:  no (public projects still readable; run `cosense login` for private ones)
```

## Private projects

Everything above works with no credentials at all, because a public project
reads anonymously. A private one answers 401 until you log in, and the
credentials are the CLI's underneath, not this package's.

There are two kinds, and which one you pick decides how much this server can
reach:

```bash
cosense login https://scrapbox.io           # a personal access token
cosense login https://scrapbox.io/yuiseki   # a service account, for one project
```

A personal access token covers every project you belong to. A service account
is registered against one project and covers only that one, so it is the way
to hand an assistant part of your wiki rather than all of it. When both apply,
the project's service account wins; `COSENSE_PAT` in the environment wins over
both.

Three things about this are easy to get wrong:

- `cosense login` reads the secret with the terminal in raw mode, so it needs a
  TTY. It cannot be run from a service manager, a hook or an assistant. Log in
  at a terminal first, then start the server.
- **A default project is not a permission.** `COSENSECLI_DEFAULT_PROJECT` only
  fills in an argument that was left out, and every tool still accepts
  `project_url`. Narrowing what this server can read is done by the credential,
  never by the default.
- Adding credentials does not need a restart. Each tool call spawns a fresh
  `cosense`, which reads the settings file itself, so a login lands on the next
  call. The line this server prints at startup is a snapshot of that moment and
  says so; `cosensecli doctor` re-reads.

Under a sandbox that mounts the home directory read-only, a settings file
written after the service started is still visible, because the mount is of the
live directory rather than a copy. The same sandbox stops anything here from
writing it, which is the right way round: reading credentials is this server's
job and writing them is not.

## MCP server

```bash
cosensecli --mcp-server
```

`--mcp`, `mcp-server` and `mcp` start the same thing. stdout carries only
JSON-RPC; anything meant for a human goes to stderr, including a line saying
which credentials it found, so a 401 from a private project is not a surprise.

Configured in a client:

```json
{
  "mcpServers": {
    "cosense": {
      "command": "npx",
      "args": ["-y", "@yuiseki/cosensecli", "--mcp-server"],
      "env": { "COSENSECLI_DEFAULT_PROJECT": "https://scrapbox.io/yuiseki" }
    }
  }
}
```

### Tools

Eight, all read-only.

| Tool | Answers |
| --- | --- |
| `cosense_browse_page` | One page, whole: metadata, icons, telomere, Infobox, body, related pages. By URL or by title |
| `cosense_browse_related_pages` | The 1-hop and 2-hop neighbourhood of a page, or its literate database when the page defines an Infobox |
| `cosense_search` | Full-text search across a project |
| `cosense_search_vector` | Search by meaning, over titles and the link notation in bodies |
| `cosense_list_pages` | The pages of a project, sortable by backlinks or views to find the ones acting as categories |
| `cosense_page_changes` | What changed on a page, including a rename, by pageId |
| `cosense_read_file_info` | An attached file, and the text extracted from it |
| `cosense_rank_pages` | The whole project ordered by size, backlinks, outgoing links, views or age |
| `cosense_list_projects` | The projects the credentials belong to. The one tool that needs them |

All but `cosense_rank_pages` are one command of the `cosense` CLI, returning
what that command printed.

## Ranking a project

Cosense will not sort by page size, and asking it to is not an error: an
unknown sort falls back to update order, so the answer comes back looking
plausible and being wrong. `cosense_rank_pages` orders the project here
instead, over a local index.

```
ranked by: lines desc
1. CCSE2018
   lines 663 / chars 11524 / linked 0 / views 387
```

`lines`, `chars`, `linked`, `views`, `updated`, `created` and `title` come from
the page list: 3206 pages is four requests and about half a megabyte, so the
first ranking takes a few seconds and the next takes none.

`links`, how many pages a page points at, is the expensive one. It lives in
each page body, so the project is read a bite at a time, and every answer says
how much of it is known:

```
bodies read: 40 of 3206 (1.2%), 3166 to go
note: this ranking covers the pages read so far, not the whole project.
```

Calling again continues from there. For the whole project, run the bulk form
without a connector waiting on it, from a terminal or a cron entry:

```bash
cosensecli sync                  # the default project
cosensecli sync --budget 500     # stop after 500 pages
```

`crawl` is an alias, which is the name it had first and the one that says more
plainly what it does; `sync` is what the sibling CLIs in this family call the
same thing.

About 0.67s a page, most of it process startup rather than network, so a few
thousand pages is the better part of an hour. Nothing already current is read
again, so running it twice costs almost nothing.

## Listing the URLs in a project

`sync` keeps every http(s) URL it finds in a page body, so once it has run the
links out of a project can be listed without fetching anything.

```bash
cosensecli list-gyazo               # every Gyazo URL, one per line
cosensecli list-urls                # every URL
cosensecli list-urls --host github.com
cosensecli list-gyazo --with-page   # URL and the page it is on, tab separated
cosensecli list-gyazo --json
```

stdout is URLs alone, deduplicated and sorted, so the list pipes into whatever
comes next. How many pages it covers goes to stderr, with a warning when the
sync has not finished, so half an answer is not read as the whole project.

`--host` matches a hostname suffix, which is what Gyazo needs: `i.gyazo.com`
and `nota.gyazo.com` are the same service under other names.

### What it says on stderr

Every call is announced: the tool, its arguments, whether it worked and how
long it took.

```
[cosense-mcp] cosense_search ok 412ms query="地図"
[cosense-mcp] cosense_browse_page failed 380ms title="秘密"
```

Under systemd that is the audit trail. It also means the titles and search
terms a model asked about are written to the journal, which is worth knowing
before pointing this at a private wiki.

## What it will not do

The `cosense` CLI can edit, delete and upload. None of that is reachable here.
The allowlist in `src/cosense.ts` is the only path to a command name, and
`previewEdit`, `submitEdit`, `previewDelete`, `replaceLinks`, `uploadFile`,
`deleteFile` and `login` are not on it. A tool that asked for one would be
refused before a process started.

This is a property of the code rather than a promise in a document, which is
the point: the server is meant to be reachable from an assistant, and the
question of what an assistant can do to your wiki should not rest on what a
README says. Run the write commands yourself with `cosense`. See
[ADR 002](docs/ADR/002-read-only-allowlist.md).

## Where things live

| | |
| --- | --- |
| Cache | `${COSENSECLI_CACHE_DIR:-~/.cache/cosensecli}/projects/<host>/<project>/` |
| Credentials | `~/.cosense/settings.json`, written by `cosense login`. Read here, never written |
| `COSENSE_PAT` | a personal access token, and it wins over the stored ones |
| Settings | `${XDG_CONFIG_HOME:-~/.config}/cosensecli/projects.json` |
| `COSENSECLI_DEFAULT_PROJECT` | the project a call is about when it names none, and it wins over the file |
| `COSENSECLI_CACHE_DIR` | where the index and the link data are kept |
| `COSENSECLI_COSENSE_BIN` | the `cosense` executable to run, instead of the bundled one |

The cache holds the page index and, for pages that have been read, their
outgoing links. Under a megabyte for a 3206 page project, since page bodies are
not kept.

Every cached entry carries the `updated` the page list reported when it was
written, and is used only while that token still matches. So the cache makes
answers faster without making them older: an edited page is read again, and a
page nobody touched is not. Nothing expires on a timer except the index itself,
which is re-walked when it is more than fifteen minutes old.

Reading never creates a directory, so the server still works under a sandbox
with a read-only home, up to the point where it wants to write. Where that
matters, `COSENSECLI_CACHE_DIR` has to be writable. See
[ADR 007](docs/ADR/007-a-cache-with-invalidation.md).

## Development

```bash
npm install
npm run build
npm test
```

The tests spawn the built CLI and speak JSON-RPC to it over a pipe, so they
cover the framing too. Nothing in them reaches Cosense: `COSENSECLI_COSENSE_BIN`
points at a stub that records the argv it was called with and prints a canned
answer, which is what makes the argument building testable at all.

The decisions behind the shape of this thing are in [docs/ADR](docs/ADR),
including why it wraps the CLI instead of reimplementing it, why it starts
without credentials, why reach is scoped by the credential rather than by the
default project, and why the cache is as greedy as gyazocli's but validates
what gyazocli never had to.

## License

MIT. The CLI this wraps, [`@helpfeel/cosense-cli`](https://github.com/helpfeel/cosense-cli),
is MIT as well.
