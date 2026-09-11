# ADR 004: Tool descriptions carry what a Skill would have said

## Status

Accepted.

## Context

`@helpfeel/cosense-cli` splits its knowledge deliberately
(`docs/guidelines/cli-vs-skill.md`): `--help` holds mechanics, and how to work
with Cosense holds in `skills/cosense/SKILL.md` and the procedure documents it
links. The stated rule is that `--help` does not say when to use a command.

An MCP client loads no Skill. It sees tool names, descriptions and argument
schemas, and nothing else. Under that split, everything about how to read a
wiki would be missing.

## Decision

The tool descriptions here carry the parts of that knowledge a client cannot
work without, and only those parts:

- A Cosense URL runs from `https://` to the first whitespace, and a title can
  be a Japanese sentence whose spaces appear as `_`. Cutting the URL at a
  script boundary fetches a different page, and Cosense answers that one, so
  the mistake arrives as a plausible wrong answer rather than an error.
- Reading one page is usually not enough. The context lives in the
  neighbourhood, which is why `cosense_browse_related_pages` exists as its own
  tool and is described as a step rather than an extra.
- Pages with many backlinks or a high pageRank act as categories, which is what
  makes sorting `cosense_list_pages` by `linked` a way into an unfamiliar
  project.
- Vector search covers titles and link notation, not whole bodies. Choosing
  between it and full text needs that fact.

Mechanics stay out. Argument shapes are in the schema, and anything deeper is
in `cosense <command> --help`, which remains the single source.

## Consequences

- These descriptions duplicate, in substance, part of an upstream Skill. When
  that Skill changes its advice, this drifts silently. The mitigation is that
  the list is short and about Cosense itself rather than about the CLI.
- Descriptions are a context cost on every client that connects, so a fact
  earns its place only if a client would get a wrong answer without it.
