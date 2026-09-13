# ADR 006: Private projects, and scoping by credential rather than by default

## Status

Accepted. Nothing here is configured yet: the deployment this was written for
runs with no credentials, against a public project. It is written down now
because the request to read a private project is expected, and the decision is
easier to make before there is a token in place than after.

## Context

[ADR 003](003-no-credentials-required.md) settled that the server starts with
whatever credentials exist, including none, because a public project reads
anonymously. That leaves open what happens when someone does want a private
project read.

The CLI underneath offers two kinds, and they differ in reach:

- A personal access token, registered per origin, covering every project the
  person belongs to.
- A service account, registered per project, covering that one.

`resolveCredential` in the CLI prefers the project's service account, falls
back to the origin's token, and `COSENSE_PAT` in the environment wins over
both.

There is also a tempting wrong answer. This package has
`COSENSECLI_DEFAULT_PROJECT`, and it would be easy to read that as "the project
this server is for". It is not. It fills in an argument that was omitted, and
every tool still takes `project_url`, so a default of one project does nothing
to stop a call naming another.

## Decision

Reach is scoped by the credential, and by nothing else.

Where a private project is wanted, a service account registered against that
project is the recommended form, because it is the only mechanism here that
narrows what the server can read. A personal access token is supported because
the CLI supports it, and because one wiki is often the whole answer, but it is
documented as the wide option rather than the default suggestion.

The default project is documented as not a permission, in the README and here,
because the failure mode is silent: someone sets the default, believes the
server is confined to one project, and it is not.

Two facts that follow from the architecture are documented rather than left to
be discovered:

- A login takes effect without restarting the server. Each tool call spawns a
  fresh `cosense`, which reads the settings file itself, so nothing is cached
  across calls. The startup line reporting credentials is therefore a snapshot
  and says so in its wording.
- Under a read-only home the settings file is still readable when written after
  the service started, because the sandbox mounts the live directory. Verified
  on the running service by reading through `/proc/<pid>/root`, which also
  confirmed the same path is not writable from inside.

`cosense login` stays out of the allowlist in
[ADR 002](002-read-only-allowlist.md). It writes, and it needs a TTY, so it
could not work here even if it were allowed; it is excluded for the first
reason.

## Consequences

- Turning on a private project is a decision about reach, made once, at the
  terminal, by a person. That is the right place for it.
- The security posture changes when it happens, and not gradually: before, the
  only thing reachable was information anyone could read. After, it is whatever
  the credential covers. Anything written about what this server exposes has to
  be re-read at that moment rather than assumed to still hold.
- Page titles reach the journal through the audit log, and a private project's
  titles are as revealing as its bodies, often more compactly. That cost
  arrives with the credential, not with the tool call.
