// make-bookmarklet-gemini.mjs - minify chat-export-gemini.js with terser and emit a javascript: URL.
//
// Usage (Node >= 18):
//   npm i -D terser
//   node make-bookmarklet-gemini.mjs [input.js] [--debug] [--out file.txt]
//
// Writes bookmarklet.txt by default (no trailing newline) and prints its length.
// --debug flips CONFIG.DEBUG to true in the built bookmarklet without editing the source file.
import { readFile, writeFile } from 'node:fs/promises';
import { minify } from 'terser';

const args = process.argv.slice(2);
const debug = args.includes('--debug');
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? args[outIdx + 1] : 'bookmarklet.txt';
if (outIdx >= 0 && (!outFile || outFile.startsWith('--'))) throw new Error('--out needs a file name');
const input = args.find((a, i) => !a.startsWith('--') && i !== outIdx + 1) || 'chat-export-gemini.js';

let src = await readFile(input, 'utf8');

if (debug) {
  const patched = src.replace(/DEBUG:\s*false/, 'DEBUG: true');
  if (patched === src) throw new Error('Could not find "DEBUG: false" in ' + input);
  src = patched;
}

const result = await minify(src, {
  compress: { passes: 2 },
  mangle: true,
  format: {
    comments: false,   // strips all comments, including the /*! banner
    ascii_only: true,  // escape non-ASCII literals so the URL is plain ASCII before encoding
    semicolons: true
  }
});
if (!result.code) throw new Error('terser produced no output');

// terser drops the leading `void` of the source (the result is unused), which would leave a Promise as the
// script's completion value. End the body with `void 0;` so the bookmark's value is always undefined and a
// javascript: URL can never navigate or render its result.
const body = result.code.replace(/[;\s]*$/, ';') + 'void 0;';

// encodeURIComponent applied ONCE to the whole body, then the scheme prefix (never encode the prefix).
const url = 'javascript:' + encodeURIComponent(body);

await writeFile(outFile, url, 'utf8');
console.log(`${outFile} written: ${url.length} characters (minified source ${body.length})`);
if (url.length > 60000) {
  console.warn('WARNING: very long bookmark URL; some browsers truncate bookmark/URL fields. ' +
               'Fallback: paste the source into the DevTools console, or save it as a DevTools Snippet.');
}
