// Adds a headline strip to a picture.
//   npx tsx example.ts photo.png "Fresh linen for hot days" "#E63946"     → photo-headline.png
// Needs ffmpeg with libass on PATH (or FFMPEG=/path/to/ffmpeg).
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { addHeadline, canBurnSubtitles, headlineAss } from "./src/index.js";

const [input, text = "Fresh linen for hot days", accent = "#E63946"] = process.argv.slice(2);
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";

if (!input || !(await canBurnSubtitles(ffmpeg))) {
  console.log("Usage: npx tsx example.ts <picture.png|jpg> [headline] [#RRGGBB]\n" +
    "Needs ffmpeg built with libass (`ffmpeg -filters | grep subtitles`); set FFMPEG to use another binary.\n" +
    `ffmpeg with subtitles: ${await canBurnSubtitles(ffmpeg) ? "yes" : "no"}\n\nThe ASS file it would burn for a 1024×1280 picture:\n`);
  console.log(headlineAss(text, 1024, 1280, accent));
  process.exit(0);
}
const out = await addHeadline(new Uint8Array(await readFile(input)), text, { fontsDir: fileURLToPath(new URL("./fonts/", import.meta.url)), accent, ffmpeg });
const path = input.replace(/\.[^./]+$/, "") + "-headline.png";
await writeFile(path, out);
console.log(`wrote ${path} (${Math.round(out.length / 1024)} KB)`);
