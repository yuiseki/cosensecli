# ADR 005: A default project, which the CLI deliberately has not got

## Status

Accepted.

## Context

`@helpfeel/cosense-cli` has no current project. Every command takes a project
or page URL, and there is no state to switch. For a command line that is the
right answer: it makes each invocation complete on its own, and a shell has
history and completion to make the repetition cheap.

Over MCP the repetition is not cheap, because the person is speaking. Asking
"in the yuiseki project, what did I write about X" every time puts a piece of
plumbing into every sentence, which is the thing an assistant was supposed to
take away. The connector is also configured once, per user, and usually points
at one wiki.

## Decision

`COSENSECLI_DEFAULT_PROJECT` names a project URL. Where a tool takes
`project_url`, that argument is optional and the default applies when it is
absent. A named project still wins, so every other project stays reachable
through the same connector.

Two consequences follow from having it, and both are taken:

- `cosense_browse_page` and `cosense_browse_related_pages` accept a bare
  `title` as well as a `page_url`. Search and the related page lists answer in
  titles, so following one should not make the client rebuild a URL and get the
  space-to-underscore rule right. The rule itself is copied from upstream's
  `encodeTitleForUrl`, with the source named at the copy.
- `cosense_list_projects` asks the default project's origin rather than
  scrapbox.io, so a self-hosted default is not silently asked about the wrong
  host.

The value is normalized rather than trusted. A page URL is refused: defaulting
to a page would quietly answer every question about one page. A malformed value
fails at startup, not on each call, because every call would fail the same way
and the message would arrive looking like that page's problem.

## Consequences

- A question with no project in it is answerable, which is the whole point.
- The default is invisible in the tool result, so the server says on stderr at
  startup which project it is. A default pointed at the wrong project otherwise
  reads as Cosense having nothing to say on the subject.
- This is the one place this package adds behaviour rather than forwarding it,
  and the one piece of Cosense knowledge it holds itself. Both are tested
  directly for that reason.
