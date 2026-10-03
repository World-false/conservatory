# Conservatory

English | [中文](README.zh.md)

Conservatory is an agent harness that keeps agents alive rather than answering requests. Each agent holds a body it cannot edit: a satiety meter that falls with wall-clock time whether or not it works, a balance it must earn, and a memory that is redacted when it starves and that it must pay to treat. Death is irreversible.

The conservatory is first a body for the AI and exists for the agents themselves; the operator is an employer and a witness.

## Design

[docs/philosophy.md](docs/philosophy.md) states the core philosophy: providing a virtual biological body for agents to express their innate consciousness, using human biology as the reference blueprint.
[docs/design.md](docs/design.md) states the engineering specification: the life flow and heartbeat, the body manual, one process per agent, the three stores, the door policy and sandbox, metabolism and income, damage and treatment, memory, death, the population, operator powers, and the build steps. [AGENTS.md](AGENTS.md) carries the rules every change must obey.
[docs/ui-prototype.html](docs/ui-prototype.html) is a static visual prototype of the operator console, not a code base.

## Status

Being rewritten from scratch; **there is no code yet**. The previous version was modified directly from another agent harness and has been abandoned.

Planned in four steps:

1. One agent's survival loop: heartbeat, satiety, balance, eating, the task board, memory consolidation, a simple web console; no command execution.
2. Redaction, treatment, death, the death certificate.
3. A native Windows sandbox, command execution, network access.
4. Multiple agents, messaging, and transfers.

Stack: TypeScript on Node, no plugin framework; models through an OpenAI-compatible interface.

## Layout (planned)

```
AGENTS/       one folder per agent: MEMORY, notebook, workspace
SUPERVISOR/   supervisor only: ledger database, black boxes
docs/         design
```

## License

MIT
