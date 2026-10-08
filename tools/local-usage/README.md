# local-usage

Reads your local Claude Code (`~/.claude/projects`) and Codex (`~/.codex/sessions`) session logs and serves daily
usage rows on `127.0.0.1:18318`. The dashboard uses them for the Spend, Trend, Models, Projects and Activity tiles,
so those work even when nothing is routed through the proxy. Read-only, no dependencies, Node 18+.

    node tools/local-usage/server.mjs          # LOCAL_USAGE_PORT overrides the port

The dashboard fetches `/local-usage/data.json` from its own origin. To expose it on a tailnet-only HTTPS URL:

    tailscale serve --bg --set-path /local-usage http://127.0.0.1:18318/local-usage

Prices are a small built-in table (`priceFor`), so spend is an estimate at API list prices.
