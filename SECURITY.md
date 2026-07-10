# Security Policy

## Supported Versions

We support security fixes for the latest release line.

| Version | Supported |
| ------- | --------- |
| latest  | yes       |
| older   | no        |

## Reporting a Vulnerability

Please do not report security vulnerabilities in public GitHub issues.

Use GitHub private vulnerability reporting (preferred).

Please include:

- Affected version
- Reproduction steps or PoC
- Impact assessment
- Any suggested mitigation

## Response Targets

- Initial acknowledgement: within 72 hours
- Triage decision: within 7 days
- Fix timeline: depends on severity and complexity

We will coordinate disclosure and credit reporters unless they prefer anonymity.

## Deployment Hardening

- Remote AFFiNE destinations must use HTTPS. Plain HTTP requires the explicit
  `AFFINE_ALLOW_INSECURE_HTTP=true` opt-in and should only be used on a trusted
  private network.
- Bearer-mode HTTP MCP listeners on non-loopback interfaces require
  `AFFINE_MCP_HTTP_TOKEN` unless the unsafe
  `AFFINE_MCP_HTTP_ALLOW_UNAUTHENTICATED=true` escape hatch is explicitly set.
- Send MCP bearer tokens in the `Authorization` header. Query-string token
  authentication is disabled by default because URLs can leak through logs,
  browser history, and monitoring systems.
