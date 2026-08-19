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
- A current WebGPU-capable Chrome, Edge, Firefox, or Safari build for visual/gameplay validation

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

GitHub Actions also runs `npm ci`, `npm test`, and `npm run build` for the development branch and pull requests into `main`.

The existing development work has additionally been syntax-checked and served successfully in a headless environment. That environment does not expose WebGPU or a real keyboard/mouse gameplay loop, so release promotion still requires one final hands-on WebGPU pass for movement feel, camera behavior, shader compilation, visual stability, and the five abilities.

## Architecture

The project keeps the original GPU-oriented simulation structure while changing the material and gameplay semantics to sand:

- `src/terrain/` — heightfield, terrain, deformation, contact state
- `src/shaders/` — WGSL terrain, wake, deformation, particle, and shared shading programs
- `src/character/` — player controller, character presentation, terrain contact
- `src/vfx/` — sand wake, spray, particles, and ambient drift
- `src/` — scene orchestration, camera, abilities, input, settings, and runtime systems
- `test/` — Node-based automated tests

## Release status

This branch is a launch candidate, not yet a verified stable release. Automated build/test success is necessary but not sufficient because the application depends on real WebGPU rendering and input behavior. Before merging to `main`, complete a hands-on browser pass and confirm:

- terrain and all edited WGSL programs compile without WebGPU validation errors;
- movement, jump, dash, Sand Step, Dune Surf, and camera controls feel correct;
- all five abilities target, animate, and resolve correctly;
- dune deformation, wake, loose-sand migration, ambient drift, and landing effects remain visually stable;
- performance is acceptable on the intended launch hardware.

## License

MIT. See `LICENSE`.
