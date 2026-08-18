# Media runbook

How to add photos/videos to the site without bloating the repo. The policy
itself lives in AGENTS.md hard rule 1; this is the how-to.

## Prerequisites

`ffmpeg` (includes `ffprobe`):

- Debian/Ubuntu: `sudo apt install ffmpeg`
- macOS: `brew install ffmpeg`

Only needed for converting/checking media — not for `npm run dev:site`. CI
installs ffmpeg itself (ubuntu-latest no longer ships it).

## Adding new media

1. Convert with the helper — never hand-roll encoder flags:

   ```bash
   npm run convert:media -- video clip.mp4 site/assets/img/news/25-26/my-post/clip.webm
   npm run convert:media -- photo photo.heic site/assets/img/news/25-26/my-post/photo.jpg
   ```

   `video` accepts any input ffmpeg reads (GIF, MP4, MOV, ...) and produces
   WebM VP9, max width 640 px, no audio. `photo` produces JPG, max dimension
   1600 px (portrait included), metadata stripped. Both refuse to overwrite
   an existing file — so for an already-JPG photo, pass the output name
   explicitly to a new path, then replace the original if satisfied:

   ```bash
   npm run convert:media -- photo IMG_1234.jpg site/assets/img/news/25-26/my-post/photo.jpg
   ```

2. Reference it from the post: `<video>` tags or the `viddesc.html` include
   for motion, plain markdown images for photos. Match existing posts.

3. Verify before pushing:

   ```bash
   npm run check:assets
   ```

## Policy recap (enforced by `check:assets` and CI)

- No GIFs. Motion is WebM, ≤ 640 px wide, ≤ 2 MB per clip.
- Photos are JPG, ≤ 1600 px max dimension (portrait included), ≤ 400 KB each.
- PNG only for graphics (transparency/flat color), ≤ 400 KB.
- ≤ ~10 MB total media referenced by one post; beyond that, host externally
  and link. This one is soft — `check:assets` warns but does not fail.

## If something slips through

CI fails the PR. If a violation reaches `main` anyway, the maintainer prunes
history manually (AGENTS.md standardized behavior 2, sole exception) — ping
@aenon rather than attempting it yourself.
