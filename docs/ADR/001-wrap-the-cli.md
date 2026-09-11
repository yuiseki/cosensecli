# ADR 001: Wrap the cosense CLI rather than reimplement or upstream it

## Status

Accepted.

## Context

Cosense needed to be reachable over MCP, alongside the other MCP servers on this
machine. Three ways were open.

1. Add an MCP server to `@helpfeel/cosense-cli` and send it upstream.
2. Write a new CLI against the Cosense API, in the shape of the other packages
   here: commander, a date-based cache, and `--mcp-server` on the same binary.
3. Depend on `@helpfeel/cosense-cli` and run it as a child process.

The first is the least code, but that repository has an explicit position on
where knowledge belongs: `docs/guidelines/cli-vs-skill.md` makes the CLI a
harness for an Agent Skill, with mechanics in `--help` and everything else in
the Skill. An MCP server publishes tool schemas and descriptions to a client
that has no Skill, which is not a gap in that design but a different answer to
the same question. Asking them to carry it is asking them to carry a second
audience they did not choose.

The second matches the other packages here, but the knowledge it would
reimplement is large and still moving: the Infobox literate database, the file
and Gyazo markup expansion, the telomere summary, the page-edit preview
protocol. That knowledge is maintained upstream and would drift here.

## Decision

Depend on `@helpfeel/cosense-cli` and run `cosense <command>` as a child
process, one process per tool call.

This is only reasonable because of what that CLI already is. Its output is
written to be read by a model rather than parsed by a program, so it can be
returned verbatim as tool content. `browsePage` in particular returns the
metadata, the icons, the per-author telomere, the Infobox, the body with
attachments expanded, and the related page titles, as one Markdown document.
Nothing here could assemble that from the API for less.

The child is started with `process.execPath` and an argument array, never a
shell. Cosense titles are long Japanese sentences that routinely contain
spaces, quotes and punctuation, and a shell would read some of them as more
than one command.

## Consequences

- The Cosense API is not this package's problem, and an upstream release picks
  up here with a dependency bump.
- Startup costs about 0.15 s, since the CLI compiles its TypeScript at run time
  through `tsx`. Measured against an API call of 0.4 to 0.7 s, this is not the
  part worth optimising.
- The Node floor is whatever the CLI declares, currently 24, because the child
  runs on the same interpreter.
- Output shape is not ours. Some commands return Markdown and some return JSON,
  which is how the CLI prints them, and a client sees that difference.
