# Sculptor

An AI carves a block of virtual marble while you watch. You give it a commission; it sketches on the block, knocks the corners off, works down through point chisel, claw, flat chisel, drill and rasp, steps back to look from every side, and keeps going until it signs the base. Stone cannot be put back.

`sculptor` is a working title.

## Status

Sprint 1 of 5. The sculpting kernel runs in a worker and the page draws its block of stone through three.js `WebGPURenderer`; `?hands=1` lets you carve it by hand with a saw, point chisel, flat chisel and rasp, and `npm run shoot` captures it on both backends. No model calls yet.

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
| `npm run dev` | Dev server on port 3130. Add `?gl=1` to force the WebGL 2 backend. |
| `npm run build` | Production build. |
| `npm run typecheck` | `nuxt typecheck` over `app/`, `server/` and `shared/`. |
| `npm run lint` | ESLint. |
| `npm test` | `node --test tests/*.test.ts`: the kernel's tests, no browser. |
| `npm run shoot -- --gl` | Headless screenshot on software WebGL 2. For layout and logic. |
| `npm run shoot -- --gpu` | Screenshot from a headed Chrome on WebGPU. The only mode for judging the look. |

`shoot` needs the dev server running. It writes `.shots/<name>_<mode>.png` (gitignored) and exits non-zero if the capture is blank, the page threw, or the backend is not the one asked for. Options: `--name`, `--query "hands=1&..."`, `--url`, `--w`, `--h`, `--frames`, `--wait`, `--out`.

## How it will work

- The stone is a voxel grid of signed distances. Carving is subtraction; a mesh is rebuilt only where a cut landed.
- The model issues passes ("rough out to this form with the point chisel"). A deterministic hand turns each pass into the individual strikes you see.
- The model looks through neutral orthographic renders with a centimetre grid, plus measurements computed by code.
- The kernel is plain TypeScript shared by the browser studio and a headless Node bench, so models can be compared as sculptors.
- A sculpture is its log of strikes, which makes replays and film export free of model calls.
- Optionally, and out of sight, the sculptor works from a reference sheet made by an image model.

## Stack

Nuxt 4 at the repo root, Nuxt UI, three.js `WebGPURenderer` with TSL, Vercel AI SDK through the AI Gateway. Dev server on port 3130.
