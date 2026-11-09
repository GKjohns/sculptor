# Sculptor

An AI carves a block of virtual marble while you watch. You give it a commission; it sketches on the block, knocks the corners off, works down through point chisel, claw, flat chisel, drill and rasp, steps back to look from every side, and keeps going until it signs the base. Stone cannot be put back.

`sculptor` is a working title.

## Status

Planning. No app code yet.

- Plan: [internal_docs/20261108_ai_sculptor/implementation_plan.md](internal_docs/20261108_ai_sculptor/implementation_plan.md)
- Storyboard (open in a browser): [internal_docs/20261108_ai_sculptor/storyboard.html](internal_docs/20261108_ai_sculptor/storyboard.html)
- Research: [internal_docs/20261108_ai_sculptor/research_notes.md](internal_docs/20261108_ai_sculptor/research_notes.md)

## How it will work

- The stone is a voxel grid of signed distances. Carving is subtraction; a mesh is rebuilt only where a cut landed.
- The model issues passes ("rough out to this form with the point chisel"). A deterministic hand turns each pass into the individual strikes you see.
- The model looks through neutral orthographic renders with a centimetre grid, plus measurements computed by code.
- The kernel is plain TypeScript shared by the browser studio and a headless Node bench, so models can be compared as sculptors.
- A sculpture is its log of strikes, which makes replays and film export free of model calls.
- Optionally, and out of sight, the sculptor works from a reference sheet made by an image model.

## Stack

Nuxt 4 at the repo root, Nuxt UI, three.js `WebGPURenderer` with TSL, Vercel AI SDK through the AI Gateway. Dev server on port 3130 once Sprint 1 lands.
