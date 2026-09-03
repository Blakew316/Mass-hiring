// Bundles the Express app + every dependency into ONE file at
// netlify/functions/api.mjs. Netlify packages modern-format functions by
// tracing imports rather than bundling, and that tracing missed this app's
// dependencies (the deployed function failed to load). A single
// self-contained file leaves nothing to trace.
import { build } from 'esbuild';
import { mkdirSync } from 'fs';

mkdirSync('netlify/functions', { recursive: true });
await build({
  entryPoints: ['netlify/src/api.mjs'],
  outfile: 'netlify/functions/api.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
  logLevel: 'info',
  // Bundled CommonJS packages still use require()/__dirname/__filename. Netlify's
  // packager prepends its own `let require/__dirname/__filename` shims to the
  // entry file, so ours must not redeclare those names: __dirname/__filename are
  // rewritten to unique identifiers, and require is provided as a global fallback.
  define: { __dirname: '__nfDirnameValue', __filename: '__nfFilenameValue' },
  banner: {
    js: [
      "import { createRequire as __nfCreateRequire } from 'module';",
      "import { fileURLToPath as __nfFileURLToPath } from 'url';",
      "import { dirname as __nfDirname } from 'path';",
      'var __nfFilenameValue = __nfFileURLToPath(import.meta.url);',
      'var __nfDirnameValue = __nfDirname(__nfFilenameValue);',
      "if (typeof globalThis.require === 'undefined') globalThis.require = __nfCreateRequire(import.meta.url);",
    ].join('\n'),
  },
});
console.log('Built netlify/functions/api.mjs');
