# Image headline

Burns a headline strip in the brand colour onto a picture with ffmpeg + ASS subtitles — your font, readable text
colour, balanced two-line wrap. Text on pictures stays sharp because you draw it, not the image model.

## Copy it

```sh
cp -r kits/content/image-headline your-project/src/image-headline
npm i -D typescript vitest @types/node tsx   # only to run its tests/example; no runtime dependencies
```

```ts
import { addHeadline, pickAccent } from "./image-headline/src/index.js";
```

Needs **ffmpeg built with libass** on the machine (`ffmpeg -filters | grep subtitles`). Debian/Ubuntu
`apt install ffmpeg` and the static builds have it; Homebrew's default `ffmpeg` formula currently does not. The
Montserrat ExtraBold font (SIL OFL, `fonts/OFL.txt`) is included.

## Use it

```ts
import { fileURLToPath } from "node:url";

const out = await addHeadline(pngBytes, "Fresh linen for hot days", {
  fontsDir: fileURLToPath(new URL("./image-headline/fonts/", import.meta.url)),
  brandColors: ["#F5F2EB", "#1C2A3A", "#A83232"],   // picks #A83232 (most vivid usable)
});
// out: PNG bytes, same size, with a red strip at the bottom and white upper-case text
```

Just the subtitle file (to burn it your own way): `headlineAss(text, width, height, "#A83232")`.

## Options

`addHeadline(picture, text, options)` — PNG/JPEG in, PNG out.

| Option | Default | What |
|---|---|---|
| `fontsDir` | — | Folder with the font file(s). |
| `accent` | — | `"#RRGGBB"` strip colour. |
| `brandColors` | — | Used when no `accent`: the most vivid colour that isn't near-white/near-black; `#007AFF` if none. |
| `font` | `"Montserrat ExtraBold"` | Font family name as the font file declares it. |
| `sizeOfWidth` | `0.078` | Font size as a share of the picture width. |
| `upper` | `true` | Upper-case the headline. |
| `ffmpeg` | `"ffmpeg"` | ffmpeg binary. |
| `timeoutMs` | `60000` | ffmpeg timeout. |

Also exported: `applyHeadline({ input, output, ass, fontsDir })` (files), `headlineArgs` (the ffmpeg argv),
`canBurnSubtitles(ffmpeg)`, `pickAccent`, `onColor`, `assColor`, `balance`, `imageSize`.

## How it works

1. `imageSize` reads width × height from the PNG/JPEG header.
2. `headlineAss` writes an ASS script sized to the picture: layer 0 is a vector rectangle across the bottom in the
   accent (94 % opaque); layer 1 is the headline, upper-cased, braces/backslashes stripped (no ASS overrides from
   user text), wrapped into two lines of similar length, in near-black or white — whichever reads on the accent.
3. ffmpeg's `subtitles` filter (libass) burns it in, one frame, in a temp folder that is removed afterwards.

No retry: ffmpeg is local and deterministic; a failure says why (including "not found").

## Tested

`npm test` — 16 tests: accent picking, ASS colour order, readable text colour, wrapping, the ASS file (size, band
position and colour, stripped overrides, custom font/size/case, bad input), PNG/JPEG size reading, filter-path
escaping, and the "ffmpeg not found" failure path. One **real render test** (strip colour sampled at the bottom,
top untouched, size kept) runs only when ffmpeg on PATH has libass — otherwise it is skipped with a note. It was run
in Docker (`node:24-bookworm` + Debian ffmpeg).

Not tested: other fonts' metrics, very long headlines (more than two lines are not wrapped further), non-PNG/JPEG input.

## Came from

Nearchant's post pictures: `apps/worker/src/image-text.ts` (`headlineAss`, `applyHeadline`) and the colour helpers
in `apps/worker/src/video-compose.ts`, called from `renderPicture` in `apps/worker/src/content-tasks.ts` — the clean
picture is kept for videos, the one with the strip is posted.
