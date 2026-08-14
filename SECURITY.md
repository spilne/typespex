# Security Policy

## Supported versions

TypeSpex has not published a release. Security fixes currently target the latest commit on
`master`; no package version is supported until an initial release is explicitly announced.

## Report a vulnerability privately

Do not disclose a suspected vulnerability in a public issue, discussion, pull request, or test
fixture. Use the repository's
[private vulnerability report](https://github.com/spilne/typespex/security/advisories/new) instead.

Include, when available:

- the affected package, commit, and runtime;
- the security impact and required attacker capabilities;
- minimal reproduction steps or a proof of concept;
- known mitigations or workarounds; and
- any intended disclosure timeline.

If private vulnerability reporting is unavailable, open a public issue containing only a request
for a private security contact. Do not include vulnerability details, credentials, private paths,
logs, or a reproduction in that issue.

Maintainers aim to acknowledge a complete report within seven days and will coordinate validation,
remediation, and disclosure through the private advisory. Response and resolution times depend on
the report's severity and reproducibility.

## Scope

Reports concerning generated request validation, routing, response encoding, supported hosting
adapters, package contents, and repository automation are in scope. Unsupported configurations,
social engineering, denial of service that requires unbounded trusted input, and vulnerabilities
in upstream dependencies without a demonstrated TypeSpex impact may be closed as out of scope.

Please avoid accessing data that is not yours, disrupting services, or publishing details before a
fix and disclosure plan are agreed.
