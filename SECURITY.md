# Security reports

Please use the repository's **Security → Report a vulnerability** for private disclosure when available.
If that option is unavailable, open an issue asking for a private contact without publishing exploit details.

Do not include personal photos, databases, face crops, preview caches or a private `?k=` link in a report.
Startup logs can contain local paths; redact them before sharing. Reproduce with the bundled sample where possible.

The desktop app listens on loopback only. Browser mode can opt into LAN access with `--lan`; its private link
grants access to that running installation. Do not expose the app directly to the internet. This preview has no
automatic updater; check Releases for fixes. Security fixes target the latest preview release.
