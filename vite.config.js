import { defineConfig } from "vite";

export default defineConfig({
    // GitHub Pages serves project sites from /SANDSTORM/. Local development
    // and other hosts continue to use the root path unless VITE_BASE is set.
    base: process.env.VITE_BASE || "/",
    server: {
        port: 5173,
        strictPort: true,
    },
    build: {
        target: "esnext",
        sourcemap: true,
    },
    // .wgsl imported via ?raw
    assetsInclude: ["**/*.hdr", "**/*.env"],
});
