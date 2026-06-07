# Security Policy

The Engineer handles credentials, accesses repositories, and runs coding agent CLIs that can execute code. The security surface is real, even this early. If you find a vulnerability, please report it privately so we can fix it before disclosure.

## Reporting a vulnerability

**Please do not file public issues for security concerns.** A public issue tells every attacker on the internet about the vulnerability before it can be fixed.

**Preferred:** Report privately through GitHub's built-in [private vulnerability reporting](https://github.com/FarzamMohammadi/the-engineer/security/advisories/new):

1. Open the [Security tab](https://github.com/FarzamMohammadi/the-engineer/security) on this repository.
2. Click **"Report a vulnerability"**.
3. Fill out the form. Only the maintainers see your report.

You and the maintainer can then collaborate on a fix in a private thread before public disclosure.

**Alternative:** If you cannot use GitHub for any reason, email [farzamm.oss@gmail.com](mailto:farzamm.oss@gmail.com). Please include `[SECURITY]` in the subject line so the report is triaged quickly. GitHub remains the preferred channel because it keeps the disclosure thread, fix, and advisory all in one place.

## What's in scope

- Credential leakage (tokens, API keys, session secrets) through logs, errors, PR descriptions, or any output channel
- Workspace escape or filesystem access outside task boundaries
- Authentication or authorization bypasses in any adapter or plugin
- Code execution beyond what an coding agent CLI would legitimately perform
- Configuration parsing that allows arbitrary file reads or command execution
- Any path that allows a malicious task to compromise the host system or the user's other repositories

## What's out of scope

- Bugs that don't have a security impact — those go to [regular issues](https://github.com/FarzamMohammadi/the-engineer/issues)
- Vulnerabilities in third-party coding agent CLIs (Claude Code, Codex, OpenCode) — report those to their respective maintainers
- Social-engineering attacks that require the user to act against their own interest
- Issues that only apply to forks that have removed safety controls

## Response expectations

This project is **v1.0.0**, maintained by a single developer in their spare time. There is no formal SLA. In practice:

- I aim to acknowledge reports within a few days.
- I aim to ship a fix within a few weeks of triage, prioritized by severity.
- I will credit reporters in the published advisory unless they prefer to remain anonymous.

If a vulnerability is being actively exploited, please say so prominently in the report so I can prioritize accordingly.

## Coordinated disclosure

Once a fix ships, the advisory is published on GitHub with the reporter's credit. If a CVE is warranted, one will be requested through GitHub.

Thank you for helping keep The Engineer trustworthy.
