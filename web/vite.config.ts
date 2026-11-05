import { defineConfig } from 'vite';

// The dashboard imports the warehouse map from ../src/sim/map.ts.
export default defineConfig({ server: { fs: { allow: ['..'] } } });
