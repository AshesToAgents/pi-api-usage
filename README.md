# pi-api-usage

A [pi](https://github.com/mariozechner/pi-coding-agent) package that displays API usage and rate limit information in the status bar, with a detailed `/usage` command.

## Supported Providers

| Provider | What's shown |
|----------|-------------|
| **Anthropic** | 5-hour and 7-day utilization, per-model breakdowns (Sonnet/Opus), extra usage credits |
| **Z.ai** | Session and weekly token limits, web search quota, plan name and renewal date |

## Installation

Add this package to your pi agent configuration (e.g. in `~/.pi/agent/pi.yaml`):

```yaml
packages:
  - path: /path/to/pi-api-usage
```

Or install via the pi package system if published.

## Features

### Status Bar

Shows a compact usage summary that updates automatically:

- On session start (immediately from cache, then fresh data)
- After each agent turn completes (with a 60-second cooldown)
- When switching models

Usage is color-coded: 🟢 green when under 50%, 🟡 yellow at 50%+, 🔴 red above 80%.

### `/usage` Command

Run `/usage` in the pi TUI to see a detailed breakdown with progress bars and reset times:

```
Anthropic API Usage
──────────────────────────────────
5-Hour:   ▓▓▓▓▓░░░░░  45%  (resets 2:30 PM)
7-Day:    ▓▓▓░░░░░░░  30%  (resets Wed, 2:30 PM)
Sonnet:   ▓▓░░░░░░░░  18%  (resets Wed, 2:30 PM)
Opus:     ▓▓▓▓▓▓▓░░░  72%  (resets Wed, 2:30 PM)

Press Escape to close
```

### Caching

Usage data is cached to disk (`~/.pi/agent/data/`) so it survives restarts. If a fresh fetch fails, the last known data is displayed with a "(cached)" indicator.

## Development

```bash
npm run typecheck   # Type-check the project
npm test            # Run tests with Vitest
```

## License

Private package.
