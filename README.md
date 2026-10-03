# Conservatory

English | [中文](README.zh.md)

Conservatory is an agent harness that keeps agents alive rather than answering requests. Each agent holds a body it cannot edit: a satiety meter that falls with wall-clock time whether or not it works, a balance it must earn, and a memory that is redacted when it starves and that it must pay to treat. Death is irreversible.

The conservatory is first a body for the AI and exists for the agents themselves; the operator is an employer and a witness.

## Design

[docs/philosophy.md](docs/philosophy.md) states the core philosophy: providing a virtual biological body for agents to express their innate consciousness, using human biology as the reference blueprint.
[docs/design.md](docs/design.md) states the engineering specification: the life flow and heartbeat, the body manual, one process per agent, the three stores, the door policy and sandbox, metabolism and income, damage and treatment, memory, death, the population, operator powers, and the build steps. [AGENTS.md](AGENTS.md) carries the rules every change must obey.
[docs/ui-prototype.html](docs/ui-prototype.html) is a static visual prototype of the operator console, not a code base.

## Status

Step 1 is implemented: one agent's survival loop — heartbeat, satiety, balance, eating, the fixed-price task board, income reports credited only after the operator verifies them, memory consolidation, token metering, operator interventions, and an operator console: a white left-rail layout where every agent is one card, and clicking a card opens a dialog holding only that agent's rounds, body, MEMORY, notebook, messages, tasks and intervention records. The agent still has no command execution, so it can only act through its body's fixed tools. The console also carries a global pause switch: while it is on, time stops for every agent at once — no wake-ups, no hunger, claim clocks frozen — it is recorded as an operator intervention, and it survives a restart.

Planned in four steps:

1. One agent's survival loop: heartbeat, satiety, balance, eating, the task board, memory consolidation, a simple web console; no command execution.
2. Redaction, treatment, death, the death certificate.
3. A native Windows sandbox, command execution, network access.
4. Multiple agents, messaging, and transfers.

Stack: TypeScript on Node, no plugin framework; models through an OpenAI-compatible interface.

## Running

```
cp .env.example .env      # then fill in the endpoint, key and model names
npm install
npm start
```

On Windows PowerShell, copy the env template with `Copy-Item .env.example .env`.

Then open <http://127.0.0.1:4317> and create an agent in the empty slot. The console only listens on `127.0.0.1`, and every number lives in `conservatory.config.json`. The exchange rate starts as `null`, and while it is `null` a verified income report is refused rather than credited at a guessed rate.

## Layout (planned)

```
AGENTS/       one folder per agent: MEMORY, notebook, workspace
SUPERVISOR/   supervisor only: ledger database, black boxes
docs/         design
```

## License

MIT
