# SANDSTORM

SANDSTORM is a real-time desert action and terrain simulation built with Babylon.js, WebGPU, hand-written WGSL shaders, and Vite. It began from the SNOWFLOW rendering baseline and has been converted into an original sand-focused experience with dune deformation, wind-driven surface behavior, a fast character controller, cinematic camera work, and sand abilities.

## Current gameplay

- Camera-relative 360-degree movement with keyboard controls
- Ground movement, jump, coyote time, one airborne Sand Step, dash/evade behavior, and Dune Surf
- Free-look camera with recentering, landing response, dash FOV response, and follow-distance effects
- Sand-responsive terrain deformation with depression, displaced loose sand, compaction, crust, downhill migration, and exposed-crest wind streaks
- Sand wake, kick-up, landing, drift, and contact VFX using the existing particle/deformation systems
- Five sand abilities: Dune Surge, Sand Lance, Fulgurite Garden, Sand Eruption, and Sand Vortex
- Desert sky, atmosphere, heat treatment, terrain shading, and character presentation adapted for the SANDSTORM setting

## Requirements

SANDSTORM requires a WebGPU-capable browser and GPU. There is intentionally no WebGL fallback in the current renderer.

Development requirements:

- Node.js 22 recommended
- npm
- A current WebGPU-capable browser for visual/gameplay validation

## Install and run

```bash
npm ci
npm run dev
```

Vite will print the local development URL.

## Validation

```bash
npm test
npm run build
```

GitHub Actions runs `npm ci`, `npm test`, and `npm run build` for `main`, the development branch, and pull requests into `main`. A separate Pages workflow builds and deploys `main` as the public browser build.

## Architecture

- `src/terrain/` — heightfield, terrain, deformation, contact state
- `src/shaders/` — WGSL terrain, wake, deformation, particle, and shared shading programs
- `src/character/` — player controller, character presentation, terrain contact
- `src/vfx/` — sand wake, spray, particles, and ambient drift
- `src/` — scene orchestration, camera, abilities, input, settings, and runtime systems
- `test/` — Node-based automated tests

## Release status

The repository is configured as a distributable WebGPU browser release: automated tests and production builds are enforced in CI, and pushes to `main` are deployed through GitHub Pages. Because the renderer intentionally requires WebGPU, target-device acceptance remains part of release QA. On representative launch hardware confirm terrain/WGSL rendering, movement and camera feel, all five abilities, deformation/VFX stability, and acceptable frame pacing.

Browsers without WebGPU receive the application's explicit unsupported-GPU state rather than a silent blank screen.

## License

MIT. See `LICENSE`.
