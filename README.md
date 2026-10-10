# SpeakHarness

Read AI coding-harness answers aloud from your terminal — locally. Follows OMP, Pi, Codex and Claude Code sessions, turns markdown into natural speech (code blocks are announced, never read), and picks the voice per paragraph: Kokoro for English, Piper for Brazilian Portuguese.

## Install

```sh
nix profile add github:Matheuscara/speak-harness
speakh
```

On Linux, the Nix package also installs a **SpeakHarness** application-menu entry that opens the terminal interface. The development-only command `bun src/cli/main.ts` is not needed to use the app. For a one-off run without installing: `nix run github:Matheuscara/speak-harness`.

`speakh setup` downloads the default voices (Kokoro q4 ~305 MB, Piper faber ~63 MB) into `~/.cache/speak-harness`. Audio plays through `pw-play`, `paplay`, `aplay`, `afplay` or `ffplay`.

## Use

| Command | What it does |
| --- | --- |
| `speakh` | Reader panel: asks which harness session to read (esc = newest in this directory) |
| `speakh --latest` | Reader panel following the newest session here, without asking |
| `speakh run -- omp` | Runs the harness inside SpeakHarness with the reader beside it: `ctrl+g` then a key runs one command; `ctrl+g` then `→` keeps the keyboard in the reader until `esc` or `←` |
| `speakh say file.md` / `… \| speakh say -` | Reads markdown once |
| `speakh follow` | Auto-reads new answers, no UI |
| `speakh ctl replay-message` | Controls a running instance (tmux bindings, aliases) |
| `speakh voices list` / `install <id>` | Manage voices |
| `speakh logs` | Shows the log (`~/.local/state/speak-harness/speakh.log`): warnings, errors, followed sessions |

### Finding a conversation

The opening screen starts with conversations from the current folder. Use `tab` for every folder; `1` shows all harnesses, `2` OMP, `3` Pi, `4` Codex, `5` Claude Code. Press `/` to search titles, harnesses and folders (case/accent-insensitive); `enter` returns to the results, then `enter` follows the highlighted conversation. The `a` key toggles the complete file list: old empty Claude Code runs and known title-generation/test prompts stay out of the curated view, while recently started and currently followed sessions always remain visible. The bars above the list show real session counts by harness for the current scope/search.

The reader shows a segment-position rail and a subtle activity pulse while speaking. Set `SPEAKH_REDUCE_MOTION=1` or `NO_COLOR=1` to disable the pulse.

Keys (all remappable in `~/.config/speak-harness/config.toml` or the settings screen `,`): `space` play/pause, `s` stop, `h`/`l` sentence, `shift+h`/`shift+l` paragraph, `j`/`k` answer, `r` repeat, `shift+r` repeat slower, `t` study mode, `enter` continue, `p` save phrase, `0`/`1`/`2` voice auto/primary/alternate, `+`/`-` speed, `tab` sessions, `m` messages, `:` palette, `?` help, `q` quit.

**Study mode** (`t`) reads sentence by sentence, repeats slower, optionally leaves shadowing silence, and saves phrases to `~/.local/share/speak-harness/phrases.md`.

## Docs

[docs/PLAN.md](docs/PLAN.md) (product) · [docs/DESIGN.md](docs/DESIGN.md) (architecture).

## License

MIT. The bundled eSpeak-NG phonemizer (`ephone`) is GPL-3.0-or-later, so distributions including it are covered by GPL-3.0 as a combined work. Piper pt-BR voices faber/cadu/jeff: CC0 datasets; Kokoro: Apache-2.0.
