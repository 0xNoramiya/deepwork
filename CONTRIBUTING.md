# Contributing to Deepwork

Thanks for your interest. Bug reports, fixes, new providers, new tools and UI improvements are all welcome.

## Getting set up

```bash
git clone https://github.com/0xNoramiya/deepwork.git
cd deepwork
npm install
npm run dev
```

The app runs at http://localhost:5174. You don't need an API key: demo mode exercises the whole engine with a scripted stand-in for the model.

## Before you open a pull request

1. Run `npm run typecheck` and `npm test`. Both must pass; CI runs them on every pull request.
2. Keep the change focused. Unrelated refactors are easier to review as separate pull requests.
3. Add or update a test when you change engine behaviour. Tests live in `server/test/`.
4. For UI changes, include a screenshot.
5. Describe what changed and why in the pull request.

If you're planning something large, open an issue first so we can agree on the approach.

## Where things live

| Path | What it does |
| --- | --- |
| `server/engine/orchestrator.ts` | Mission lifecycle, scheduling, approvals and recovery |
| `server/engine/loop.ts` | The tool loop each agent runs |
| `server/engine/tools.ts` | The tools agents can call |
| `server/providers/` | Model provider adapters |
| `src/world/` | The submarine view |
| `src/panels/` | The side panel, settings and dialogs |
| `shared/types.ts` | Types shared by the server and the client |

## Common changes

**Adding a tool.** Define it with `define()` in `server/engine/tools.ts`. Give it a zod schema, set `reach` (`internal`, `external` or `human`), and set `consequential: true` if it can change anything outside the machine. External tools go through the approval gate automatically. If agents should be able to switch it on and off, add it to `CONFIGURABLE`.

**Adding a provider.** If it speaks the OpenAI Chat Completions protocol, add an entry to `PRESETS` in `server/providers/index.ts`. Otherwise, implement the `ModelProvider` interface from `server/providers/types.ts` and register it in `getProvider()`.

**Changing the world.** Room positions, floors and ladders are in `src/world/layout.ts`. Where an agent stands for each activity is decided in `placementFor()` in the same file.

## Code style

- TypeScript in strict mode. Match the style of the code around your change.
- Prefer failing loudly to silent fallbacks.
- Comments explain why, not what.
- Please discuss new dependencies in an issue first.

## Reporting bugs

Open an issue with steps to reproduce, what you expected and what happened. Include relevant lines from the Log tab or the server output, and remove any API keys first.

## Security

Please don't report security problems in public issues. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
