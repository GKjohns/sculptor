# Sculptor

An AI carves a block of virtual marble while you watch. You give it a commission; it sketches on the block, knocks the corners off, works down through point chisel, claw, flat chisel, drill and rasp, steps back to look from every side, and keeps going until it signs the base. Stone cannot be put back.

`sculptor` is a working title.

## Status

Sprints 1 to 4 of 5 are built. Type a commission and a model carves it live: it sketches in charcoal, saws the corners off, roughs out and refines with chisels, rasp and polish, and steps back to look, with its reasoning in a notebook and the exact images it was sent in a side panel. The film look is in: veined marble that takes a finish and lets light through thin edges, a studio lit through one window, slabs that fall and break, chips and dust, tools that work the stone, synthesised sound, and a camera director that picks the shots. Finished commissions are saved and can be replayed, stepped through pass by pass or resumed after a reload. Still to come (Sprint 5): the reveal sequence, a replay page with a scrubber, film export, a second stone and a gallery.

- Plan: [internal_docs/20261108_ai_sculptor/implementation_plan.md](internal_docs/20261108_ai_sculptor/implementation_plan.md)
- Storyboard (open in a browser): [internal_docs/20261108_ai_sculptor/storyboard.html](internal_docs/20261108_ai_sculptor/storyboard.html)
- Research: [internal_docs/20261108_ai_sculptor/research_notes.md](internal_docs/20261108_ai_sculptor/research_notes.md)
- Repo shape and rules for agents: [AGENTS.md](AGENTS.md)

## Running it

Node 22 and npm.

```bash
nvm use 22
npm install
npx playwright install chromium-headless-shell   # once, for npm run shoot -- --gl
cp .env.example .env                             # AI_GATEWAY_API_KEY; the app boots without it
npm run dev                                      # http://localhost:3130
```

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on port 3130. `?gl=1` forces the WebGL 2 backend, `?replay` lists saved runs to watch, `?hands=1` lets you carve by hand, `?film=0` leaves out debris, tools, sound and the camera director. |
| `npm run build` | Production build. |
| `npm run typecheck` | `nuxt typecheck` over `app/`, `server/` and `shared/`. |
| `npm run lint` | ESLint. |
| `npm test` | `node --test tests/*.test.ts`: the kernel, the agent loop and the saved-log replays, no browser. |
| `npm run shoot -- --gl` | Headless screenshot on software WebGL 2. For layout and logic. |
| `npm run shoot -- --gpu` | Screenshot from a headed Chrome on WebGPU. The only mode for judging the look. |
| `npm run shoot -- --gpu --lookbook` | Reshoots the 15 fixed look-book shots into `docs/look/` ([docs/look/README.md](docs/look/README.md)). |
| `npm run bench:sculpt -- --subject pawn` | One headless commission into `.data/study/`; `--dry` needs no key. |

`shoot` needs the dev server running. It writes `.shots/<name>_<mode>.png` (gitignored) and exits non-zero if the capture is blank, the page threw, or the backend is not the one asked for. Options: `--name`, `--query "hands=1&..."`, `--url`, `--w`, `--h`, `--frames`, `--wait`, `--out`, and for the film `--preset`, `--seek`, `--bare`, `--webp`, `--dpr`, `--sequence`, `--gesture`, `--until`, `--unthrottled` (all listed at the top of `scripts/shoot.mjs` and in [AGENTS.md](AGENTS.md)).

## How it works

- The stone is a voxel grid of signed distances. Carving is subtraction; a mesh is rebuilt only where a cut landed.
- The model issues passes ("rough out to this form with the point chisel"). A deterministic hand turns each pass into the individual strikes you see.
- The model looks through neutral orthographic renders with a centimetre grid, plus measurements computed by code.
- The kernel is plain TypeScript shared by the browser studio and a headless Node bench, so models can be compared as sculptors.
- A sculpture is its log of strikes, which makes replays and film export free of model calls.
- The film (debris, dust, tools, sound, camera) is for show: it listens to the strikes as they land and never touches the stone or its log.
- Optionally, and out of sight, the sculptor works from a reference sheet made by an image model.

## Stack

Nuxt 4 at the repo root, Nuxt UI, three.js `WebGPURenderer` with TSL, Vercel AI SDK through the AI Gateway. Dev server on port 3130.
