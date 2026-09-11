# ADR 002: Read-only is an allowlist, not a promise

## Status

Accepted.

## Context

The `cosense` CLI can write: `previewEdit`, `previewDelete`, `submitEdit`,
`replaceLinks`, `uploadFile`, `deleteFile`. It can also write credentials to
disk with `login`.

This server is reachable from an assistant, which means the answer to "what can
it do to my wiki" should not depend on which tools happen to be registered
today. Registering only read tools is a promise about the current state of one
file. A later tool added carelessly, or a bug that builds a command name from
an argument, breaks it silently.

## Decision

`src/cosense.ts` holds a literal list of the read-only commands, and
`runCosense` refuses anything not on it before starting a process. Tool
registration is separate from it and cannot widen it.

The write commands are absent by name. So is `login`, which writes credentials:
it is also TTY-only and could not work here, but it is excluded for the first
reason rather than the second.

## Consequences

- A command added upstream is not reachable here until someone adds it to the
  list, including a read-only one. That cost is accepted.
- A test asserts the list by name, so widening it is a visible change in a diff
  rather than a side effect.
- Editing stays a thing the user does at a terminal. `previewEdit` and
  `submitEdit` are a deliberate two-step with a five-minute expiry, and putting
  both behind one assistant turn would collapse a review step that exists on
  purpose.
