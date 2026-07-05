# Security Policy

## Supported Version

Security fixes target the current `main` branch and the latest published package version.

## Reporting

Please do not publish sensitive security details in a public issue. Use GitHub's private vulnerability reporting when available, or contact the maintainer through the GitHub profile with a short summary and reproduction outline.

## Security Notes

- Do not commit API keys, OAuth secrets, database URLs, Redis credentials, or production environment files.
- Keep OAuth callback URLs and hosted deployment secrets in the deployment provider, not in source control.
- Prefer environment variables for hosted server configuration.
- Treat session-detection logic carefully because it interacts with local developer tooling and process/session metadata.
