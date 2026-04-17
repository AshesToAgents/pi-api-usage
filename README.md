# pi-api-usage

A [pi](https://github.com/mariozechner/pi-coding-agent) extension that displays API usage and rate limit information in the status bar, with a detailed `/usage` command.

## Install

```bash
# Global (user-level)
pi install ssh://git@github.com/SunflowerFuchs/pi-api-usage.git

# Project-level (shared with team via .pi/settings.json)
pi install -l ssh://git@github.com/SunflowerFuchs/pi-api-usage.git

# Try without installing
pi -e ssh://git@github.com/SunflowerFuchs/pi-api-usage.git
```

## What's Included

| Type | Name | Description |
|------|------|-------------|
| Extension | — | Status bar usage summary with automatic updates |
| Command | `/usage` | Detailed API usage breakdown with progress bars and reset times |

## Supported Providers

| Provider | What's shown |
|----------|-------------|
| **Anthropic** | 5-hour and 7-day utilization, per-model breakdowns (Sonnet/Opus), extra usage credits |
| **Z.ai** | Session and weekly token limits, web search quota, plan name and renewal date |

## Usage

### Status Bar

Shows a compact usage summary that updates automatically:

- On session start (immediately from cache, then fresh data)
- After each agent turn completes (with a 60-second cooldown)
- When switching models

Usage is color-coded: 🟢 green when under 50%, 🟡 yellow at 50%+, 🔴 red above 80%.

### `/usage`

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

## How It Works

Usage data is cached to disk (`~/.pi/agent/data/`) so it survives restarts. If a fresh fetch fails, the last known data is displayed with a "(cached)" indicator.

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT
