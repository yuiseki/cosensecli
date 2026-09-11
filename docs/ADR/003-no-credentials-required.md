# ADR 003: Start without credentials

## Status

Accepted.

## Context

The other MCP servers here refuse to start without credentials, because
without them they can do nothing: a Hatena username or a Gyazo token is the
whole of the access.

Cosense is not like that. A public project reads anonymously, in full: page
bodies, related pages, search, Infobox. Requiring credentials to start would
give up a capability that works.

## Decision

Start with whatever is there. Report on stderr which of the three states
applies: `COSENSE_PAT` from the environment, `~/.cosense/settings.json`, or
nothing at all.

An HTTP 401 or 403 from a private project is returned as that tool call's
error, not as a failed startup. `cosensecli doctor` treats a 401 from `whoami`
as a working installation for the same reason, and says so in words rather than
reporting success with no detail.

## Consequences

- The server is useful the moment it is installed, against any public project.
- A user who expected a private project to be readable finds out at the first
  call rather than at startup. The stderr line at startup is what makes that
  diagnosable, so it must keep saying which credentials were found.
- The startup line names the settings file path but never the token value.
