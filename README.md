# btw-chat (Claude Code Plugin)

A side pane for a continuous `/btw`-style conversation over the session
transcript. The built-in `/btw` answers a single question and forgets it;
this pane keeps the exchange going: every answer forks the session's own
transcript (the same `$.model.fork` mechanism `/btw` uses), carries the
earlier side exchanges with it, and never touches the main conversation.

## Installation

The plugin is listed in this repository's marketplace, which serves the
plugin from the repository root.

Via chat:

```text
/plugin marketplace add Coverup20/claude-code-btw-chat
/plugin install btw-chat@claude-code-btw-chat
```

Or via CLI:

```bash
claude plugin marketplace add Coverup20/claude-code-btw-chat
claude plugin install btw-chat@claude-code-btw-chat
```

Restart Claude Code or run `/reload-plugins` after install or update.

## Usage

Run `/btw-chat` to open the "By the way" pane, type a question, press Enter.
The answer appears in the pane; ask a follow-up and it sees both the session
transcript and the earlier side exchanges (the last 12 are carried in each
fork prompt). The **Clear** button resets the side conversation. Escape
closes the pane.

The pane is placed from 144 columns (110 once opened from the command);
below that it waits undrawn for a wider terminal.

## How it works

Each submitted question calls `$.model.fork` with a prompt that embeds the
recent side Q&A pairs after the session's own transcript. Nothing is added
to the main thread, so the side conversation costs the cache prefix the same
way `/btw` does, plus the small side-conversation tail. Errors such as
`nothing-to-fork`, API failures and empty replies are reported in the pane.

## Development

- `claude plugin validate .` checks the manifest, marketplace and hooks.
- `claude plugin test .` runs the tests in `tests/`.
- Bump `version` in `package.json`, `.claude-plugin/plugin.json` and the
  marketplace entry together, then `npm publish` and push.

## License

MIT
