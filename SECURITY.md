# Security Policy

## Reporting a vulnerability

Please use the repository's private vulnerability reporting feature when it is available. Do not open a public issue with exploit details, credentials, private workspace content, or machine-specific paths.

Include the affected version or commit, operating system, reproduction conditions, expected boundary, observed behavior, and a minimal sanitized proof of concept. Remove tokens, provider payloads, repository contents, usernames, and absolute paths before submitting evidence.

## Supported scope

Security fixes target the latest revision on the default branch. This project is in active development and does not currently publish a long-term support schedule.

## Security boundaries

Workspace Trust and approval policies reduce accidental access; they do not create an operating-system sandbox. An approved command inherits the application's host permissions and network access. Use host-level isolation when working with untrusted code.
