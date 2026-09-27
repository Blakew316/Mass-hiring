// Bundles the Express app + every dependency for Netlify: the API function at
// netlify/functions/api/api.mjs and the scheduled send worker at
// netlify/functions/send-queue.mjs. Netlify packages modern-format functions by
// tracing imports rather than bundling, and that tracing missed this app's
// dependencies (the deployed function failed to load). A self-contained bundle
// leaves nothing to trace.
//
// The API is split into chunks. Everything a request needs is in api.mjs; the
// heavy parts that only onboarding paperwork uses — pdf-lib, the resume
// readers, the company PDFs themselves — are dynamic imports, and each lands in
// a chunk of its own under api/chunks/ that is loaded the first time it is
// needed. A single file would make every cold start parse all of them, twice
// the start-up time for a page that has not asked for a PDF. The chunks live
// in the function's own folder, which Netlify ships with it; api.mjs is the
// entry because it has the folder's name.
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'fs';

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
  // The built-in flyer (assets/attachments), and the onboarding documents,
  // logo and letter templates, travel inside the bundle.
  loader: { '.png': 'binary', '.pdf': 'binary', '.md': 'text' },
  // unpdf can load a separately installed pdf.js instead of its own bundled
  // build; this app never asks it to, so that import is left unresolved.
  external: ['pdfjs-dist'],
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
};

// A fresh folder each time, so no chunk from an earlier build is left behind,
// and no single-file api.mjs from before the split either (two functions
// named "api" would not deploy).
rmSync('netlify/functions/api', { recursive: true, force: true });
rmSync('netlify/functions/api.mjs', { force: true });
mkdirSync('netlify/functions', { recursive: true });

await build({
  ...shared,
  entryPoints: ['netlify/src/api.mjs'],
  outdir: 'netlify/functions/api',
  outExtension: { '.js': '.mjs' },
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
});

// The send worker needs none of that, and stays one file.
await build({
  ...shared,
  entryPoints: ['netlify/src/send-queue.mjs'],
  outdir: 'netlify/functions',
  outExtension: { '.js': '.mjs' },
});
console.log('Built netlify/functions/api/ and netlify/functions/send-queue.mjs');
