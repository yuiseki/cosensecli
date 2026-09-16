# ADR 007: A cache as greedy as gyazocli's, with the invalidation it never needed

## Status

Accepted. Supersedes the "there is no cache" position of
[ADR 003](003-no-credentials-required.md) and the README, which held while the
server only answered about one page at a time.

## Context

Cosense will not sort a project by page size. Asking it to is not an error:
an unknown `sort` falls back to update order, so a ranking by line count asked
for that way comes back looking plausible and being wrong. Answering it means
holding the project's metadata here, which means a cache.

gyazocli, the sibling this family already had, caches greedily: it writes on
every read path rather than from a sync command, never expires anything, and
had grown to 395MB across 63,000 files. That works because a Gyazo capture is
immutable. A cached copy of one cannot become wrong, so there is nothing to
invalidate and no reason to hold back.

A Cosense page is edited. The same greed, applied unchanged, would serve an
edited page's old body, and gyazocli's merge-on-write (`{...base, ...detail}`,
union of id sets) would resurrect deleted lines, because a merge has no way to
express a removal.

## Decision

Be as greedy as gyazocli, and add the one thing it has no use for.

The page list returns `updated` for up to 1000 pages per request, so a whole
project's freshness is a handful of calls. That token is what every cached
entry is checked against. A cached copy whose token still matches is known
good rather than assumed good, which is the property gyazocli gets for free
from immutability and this has to earn.

Three consequences follow, and each is the opposite of what gyazocli does:

- **Replace, never merge.** A removal has to be expressible.
- **The token is opaque.** It is compared for equality, never parsed for
  ordering, the way an ETag is used. The CLI prints timestamps in a human form
  and an earlier version of this ran them through `Number()`, storing 0 for
  all 3206 pages and killing the validation axis before anything relied on it.
  A separately parsed value carries ordering, and is null rather than 0 when
  the parse fails.
- **Store what can be validated.** Outgoing links are kept; rendered page
  bodies are not. A rendering depends on other pages, since the related list
  moves when something else links here, so this page's `updated` could not
  vouch for it. Links are a property of the body alone, so it can.

The index is versioned, so an index written by an older build is discarded
rather than reinterpreted.

## Consequences

- The server now writes, where it did not. `~/.cache/cosensecli` has to be in
  the sandbox's `ReadWritePaths`, and the claim that nothing there is writable
  no longer holds. See the security note in the operations documentation.
- Reading still creates no directory. A sandbox with a read-only home survives
  a cache miss, which is the lesson hatebucli learned by taking a tool call
  down with an `mkdir` on the way to a file that was not there.
- Answers carry their own provenance: how old the index is, how much of the
  project a ranking covers, and whether the walk was cut short. A partial
  ranking that did not say so would read as a fact about the whole project.
- Reading every body is about 35 minutes for 3206 pages, most of it process
  startup rather than network. That is a cron job (`cosensecli crawl`), not a
  tool call, so tool calls take a bounded bite and converge.
- The ETag the API actually sends is not reachable from here, because the CLI
  does not surface response headers. `updated` is the available equivalent and
  is better suited anyway: one request covers a thousand pages, where a
  conditional request covers one.
