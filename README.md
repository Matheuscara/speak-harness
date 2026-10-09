# SpeakHarness

Read AI coding-harness answers aloud from your terminal — locally. Follows OMP, Pi, Codex and Claude Code sessions, turns markdown into natural speech (code blocks are announced, never read), and picks the voice per paragraph: Kokoro for English, Piper for Brazilian Portuguese.

## Install

```sh
nix run github:Matheuscara/speak-harness          # Nix
# or, from a checkout (Bun ≥ 1.3.14 and Node ≥ 22.18 on PATH):
bun install && bun src/cli/main.ts setup
```

`speakh setup` downloads the default voices (Kokoro q4 ~305 MB, Piper faber ~63 MB) into `~/.cache/speak-harness`. Audio plays through `pw-play`, `paplay`, `aplay`, `afplay` or `ffplay`.

## Use

| Command | What it does |
| --- | --- |
| `speakh` | Reader panel: follows the newest harness session in the current directory |
| `speakh run -- omp` | Runs the harness inside SpeakHarness with the reader beside it; `ctrl+g` then a key sends commands |
| `speakh say file.md` / `… \| speakh say -` | Reads markdown once |
| `speakh follow` | Auto-reads new answers, no UI |
| `speakh ctl replay-message` | Controls a running instance (tmux bindings, aliases) |
| `speakh voices list` / `install <id>` | Manage voices |

Keys (all remappable in `~/.config/speak-harness/config.toml` or the settings screen `,`): `space` play/pause, `s` stop, `h`/`l` sentence, `shift+h`/`shift+l` paragraph, `j`/`k` answer, `r` repeat, `shift+r` repeat slower, `t` study mode, `enter` continue, `p` save phrase, `0`/`1`/`2` voice auto/primary/alternate, `+`/`-` speed, `tab` sessions, `m` messages, `:` palette, `?` help, `q` quit.

**Study mode** (`t`) reads sentence by sentence, repeats slower, optionally leaves shadowing silence, and saves phrases to `~/.local/share/speak-harness/phrases.md`.

## Docs

[docs/PLAN.md](docs/PLAN.md) (product) · [docs/DESIGN.md](docs/DESIGN.md) (architecture).

## License

MIT. The bundled eSpeak-NG phonemizer (`ephone`) is GPL-3.0-or-later, so distributions including it are covered by GPL-3.0 as a combined work. Piper pt-BR voices faber/cadu/jeff: CC0 datasets; Kokoro: Apache-2.0.
