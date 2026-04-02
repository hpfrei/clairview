# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in vistaclair, please report it responsibly through GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/hpfrei/vistaclair/security) of this repository
2. Click **Report a vulnerability**
3. Provide a description of the issue and steps to reproduce

Please do **not** open a public issue for security vulnerabilities.

I will review reports promptly and work with you on a fix before any public disclosure.

## Scope

vistaclair is a local development tool that proxies API traffic. Key areas of concern include:

- Exposure of API keys or credentials through the proxy or dashboard
- Unauthorized access to the dashboard or proxy endpoints
- Code injection via crafted prompts or API responses

## Best Practices

When running vistaclair, keep in mind:

- The **proxy** binds to `localhost` only — it is not reachable from other machines
- The **dashboard** binds to `0.0.0.0` (all interfaces) so you can access it from other devices — it is protected by an auth token, but avoid exposing it to untrusted networks without additional safeguards (TLS, VPN, firewall)
- API keys are forwarded to the Anthropic API but are never logged or persisted by vistaclair
- Interaction logs saved to disk may contain sensitive data from your prompts and responses
