---
name: web-scroll-video
description: Create MP4 videos of web pages scrolling or interacting at a steady producer-directed pace using the local web-scroller-tool repository. Use when Codex needs to capture a URL as a 1080p scroll animation, translate plain-English video direction into a sequence-style cue sheet with pauses/clicks/typing/zooms/highlights, adjust viewport size, FPS, scroll speed, duration, cursor visibility, Chrome or ffmpeg paths, storyboard output, or validate generated video metadata.
---

# Web Scroll Video

Use this skill to render a web page into a steady scrolling or lightly interactive MP4 with the local Node CLI in this repository.

When users ask for help, describe the producer workflow in plain English: they can describe the desired video sequence, and Codex can turn it into a cue sheet. Keep the user-facing language about timing, pauses, clicks, typing, zooms, highlights, frame rate, cursor visibility, and output filenames. Avoid asking them for CSS selectors unless visible text or labels are not enough.

## Workflow

1. Confirm prerequisites are available:

```bash
node --version
ffmpeg -version
```

2. Check the CLI syntax after edits:

```bash
node --check src/scroll-video.mjs
```

3. Capture a URL:

```bash
node src/scroll-video.mjs https://www.wharton.upenn.edu/ --out wharton-scroll.mp4
```

Use `npm run capture:wharton` for the built-in Wharton example.

4. For pauses and interactions, create a sequence-style `.cue` file:

```text
out: demo.mp4
fps: 60
cursor: off

go https://www.wharton.upenn.edu/faculty-directory/
pause 1
highlight "Faculty Directory" for 1
scroll to 1800 over 4
click "Departments"
pause 1
type "finance" into "Search"
pause 1
zoom to 1.2 over 1
scroll to bottom over 5
```

Run it:

```bash
node src/scroll-video.mjs --script demo.cue
```

In script mode, store the `.cue` and generated `.mp4` together. Relative `out:` paths resolve next to the cue file, and omitting `out:` writes `<cue-name>.mp4` beside the cue.

5. Validate the output:

```bash
ffprobe -v error \
  -select_streams v:0 \
  -show_entries stream=width,height,r_frame_rate,duration,codec_name \
  -of default=noprint_wrappers=1 \
  wharton-scroll.mp4
```

Expected default metadata is H.264 video at `1920x1080` and `30/1` frame rate.

## Sharing And Install

To share this skill, publish the repository to GitHub with `SKILL.md` at the repo root. Tell users they can ask Codex to install it from the GitHub URL, or manually clone it into `${CODEX_HOME:-$HOME/.codex}/skills/web-scroll-video`, then restart Codex.

If using the skill installer helper directly:

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-installer/scripts/install-skill-from-github.py" \
  --repo <owner>/<repo> \
  --path . \
  --name web-scroll-video
```

## Capture Options

Prefer these controls:

- `--out <path>` to set the MP4 file path.
- `--width 1920 --height 1080` for 1080p landscape output.
- `--fps 30` for normal video output.
- `--speed <px/sec>` for a fixed CSS-pixel scroll rate.
- `--duration <seconds>` when the user wants the full page scroll to fit a fixed length.
- `--script <path>` when the user wants pauses, clicks, typing, zooms, highlights, or a producer-directed sequence.
- `--cursor` or `cursor: on` when the user wants a visible cursor. Keep cursor off by default.
- `--storyboard <dir>` when the user wants one PNG checkpoint after each cue step. Do not create storyboards by default.
- `--delay <ms>` when page content needs more time after load.
- `--warmup-step <px>` when lazy-loaded content needs smaller pre-scroll increments.
- `--chrome-path <path>` or `CHROME_PATH` when Chrome is not auto-detected.
- `--ffmpeg-path <path>` or `FFMPEG_PATH` when `ffmpeg` is not on `PATH`.

## Operational Notes

- The tool launches headless Chrome with a temporary profile and DevTools on `127.0.0.1`.
- In sandboxed environments, rerun with approval if local port binding or live URL access is blocked.
- Output MP4 files are ignored by git. Leave generated videos in the working tree unless the user asks to remove them.
- For cue-driven videos, keep the `.cue` and `.mp4` in the same folder. Prefer `cues/<name>.cue` and either omit `out:` or use `out: <name>.mp4`.
- One-shot scroll capture is deterministic: it captures fixed scroll positions and pipes PNG frames to `ffmpeg`.
- Cue-sheet mode captures timed frames for pauses and interactions so page animations can continue during pauses.
- If a cue step fails, inspect and mention `<output>.error.json` and `<output>.error.png`; they contain the failure message and current-page screenshot.

## Cue Sheet Guidance

Prefer `.cue` text for humans and JSON only for generated or programmatic workflows. Use sequence style, not absolute timestamps.

Supported `.cue` actions:

```text
go https://example.com
pause 1.5
scroll to bottom over 5
scroll to 1800 over 4
scroll to "Visible text" over 4
scroll by 800 over 2
click "Visible text"
click selector ".button-class"
type "search terms" into "Search"
press Enter
wait text "Results" timeout 10
zoom to 1.2 over 1
highlight "Important text" for 1.5
```

When translating plain English, make reasonable timing choices, then render and validate. If an interaction target fails, revise the cue to use a clearer visible label or selector and rerun.
