import { defineConfig } from 'tsup';
import { configs } from './tsup.shared.js';

// Single source of truth lives in tsup.shared.js (see the note there). This
// entry point is used by `tsup` / `tsup --watch` for the local dev loop, where
// tsup runs the configs in parallel — fine for iteration. The publish/CI build
// goes through `scripts/build.mjs`, which runs the SAME configs sequentially to
// avoid the parallel-DTS race that intermittently drops declaration files
// (sphere-sdk#548).
export default defineConfig(configs);
