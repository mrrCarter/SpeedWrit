import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

// Uses the repository's pinned esbuild. The bundle is local validation output; Wrangler
// publishes worker.ts directly from this checkout, including its repository public-page import.
await build({
  absWorkingDir:fileURLToPath(new URL('.',import.meta.url)),
  entryPoints:['worker.ts'], outfile:'dist/worker.mjs', bundle:true,
  format:'esm', platform:'neutral', target:'es2022', logLevel:'silent',
});
