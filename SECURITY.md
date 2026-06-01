# Security Policy

chit is early (pre-v0) and provided as-is under the MIT License. There is no
formal support or SLA yet, but security reports are welcome.

## Reporting a vulnerability

Please report privately rather than opening a public issue:

- Use GitHub's **Report a vulnerability** (the repository's Security tab opens a
  private advisory), or
- Reach the maintainer through their GitHub profile, [@caiopizzol](https://github.com/caiopizzol).

Include what you found, how to reproduce it, and the impact you expect. You will
get an acknowledgement; fixes are best-effort given the project's early stage.

## Scope

chit runs other agents' CLIs inside your own session and reads manifests you
provide. It does not run a server and stores no credentials: API keys live in
your own environment and agent configs, never in this repository.
