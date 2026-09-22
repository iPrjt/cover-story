/* Bundles the game into one self-contained page for publishing as an Artifact.
   The Artifact host supplies the document skeleton, so this file starts at
   <title> and inlines everything the page needs. */
const fs = require('fs');
const path = require('path');
const here = __dirname;
const read = f => fs.readFileSync(path.join(here, f), 'utf8');

const deck = read('deck.json');
const css = read('public/styles.css');
const engine = read('engine.js');
const view = read('view.js');
const net = read('public/net-db.js');
const app = read('public/app.js');

const NOTICE = 'Everyone at the table opens this same page and enters the code. They need to be signed in to Claude in your organisation.';

const out = `<title>Cover Story</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600;700&display=swap">
<style>
${css}
</style>

<div class="wrap" id="app"></div>

<script>window.DECK = ${deck};</script>
<script>${engine}</script>
<script>${view}</script>
<script>${net}
window.Net.notice = ${JSON.stringify(NOTICE)};
</script>
<script>${app}</script>
`;

fs.writeFileSync(path.join(here, 'dist-artifact.html'), out);
console.log('wrote dist-artifact.html —', (Buffer.byteLength(out) / 1024).toFixed(1), 'KB');
