import { readFile, writeFile, rename } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { build } from 'esbuild';
import { format } from 'prettier';

const root = resolve('.');
const read = (path) => readFile(resolve(root, path), 'utf8');
const types = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
async function dataUrl(path) {
  return `data:${types[extname(path)]};base64,${(await readFile(resolve(root, path))).toString('base64')}`;
}
async function embedAssets(text) {
  for (const match of [...text.matchAll(/\{\{asset:([^}]+)\}\}/g)])
    text = text.replaceAll(match[0], await dataUrl(match[1]));
  return text;
}
const ranges = {
  latin:
    'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  'latin-ext':
    'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
  cyrillic: 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116',
};
let fonts = '';
for (const [subset, range] of Object.entries(ranges))
  fonts += `@font-face{font-family:Nunito;font-style:normal;font-display:swap;font-weight:200 1000;src:url("${await dataUrl('assets/fonts/nunito-' + subset + '.woff2')}") format("woff2");unicode-range:${range}}\n`;
const extraIcons = await read('assets/icons/games.html');
const allIcons = (await read('assets/icons/base.html')) + (await read('assets/icons/mark.html')) + extraIcons;
const sprite = `<svg class="sprite" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${allIcons}</svg>`;
const bootstrap = `<script>\n${await read('assets/shared/preload.js')}\n</script>`;
const commonCSS = await read('assets/shared/controls.css');
const motionPresets = JSON.parse(await read('assets/shared/motion-presets.json'));
const motionChoices = motionPresets
  .map(
    (item) =>
      `<button type="button" class="motion-choice" role="radio" aria-checked="${item.id === 'hyprland'}" data-motion-style="${item.id}" tabindex="${item.id === 'hyprland' ? '0' : '-1'}"><span class="motion-choice-icon"><svg class="icon" aria-hidden="true"><use href="#i-${item.icon}"/></svg></span><span><strong>${item.title}</strong><small>${item.ru}</small></span><svg class="icon motion-choice-check" aria-hidden="true"><use href="#i-check"/></svg></button>`,
  )
  .join('');
const motionPicker = (await read('templates/motion-picker.html')).replace(
  '{{motion-choices}}',
  motionChoices,
);

const toggles = [
  ['theme', 'sun'],
  ['motion', 'rocket'],
  ['sound', 'volume'],
  ['ripple', 'wave'],
  ['particles', 'star'],
  ['liquid', 'wand'],
  ['glass', 'window'],
]
  .map(
    ([key, icon]) =>
      `<div class="setting-row"><div><label class="setting-title" for="pref-${key}"><svg class="icon" aria-hidden="true"><use href="#i-${icon}"/></svg><span data-t="${key}"></span></label><p class="setting-description" data-t="${key}Hint"></p></div><label class="toggle-control"><input type="checkbox" id="pref-${key}" data-preference="${key}"${['theme', 'sound'].includes(key) ? '' : ' checked'}><span class="toggle-track" aria-hidden="true"></span></label></div>`,
  )
  .join('\n');
const gameSettings = (await read('templates/game-settings.html')).replace('{{game-toggles}}', toggles);
const license = `<!--\nOriginal content © 2026 Aubeig / ClawBack Intelligence Division.\nInterface and game implementation adapted. Original portfolio content retains CPL v1.0 attribution.\nFont Awesome Free 6.4.0 icons © Fonticons, Inc. — CC BY 4.0, https://fontawesome.com/license/free\nNunito license:\n${await read('assets/fonts/OFL.txt')}\n@noble/hashes — MIT license:\n${await read('assets/licenses/noble-hashes.txt')}\n-->`;
for (const page of ['bio', 'games']) {
  const entry = page === 'bio' ? 'assets/bio/entry.js' : 'assets/games/app.js';
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    minify: false,
    legalComments: 'none',
    charset: 'utf8',
    loader: { '.webp': 'dataurl', '.png': 'dataurl', '.jpg': 'dataurl' },
  });
  let css = fonts + (await read(`assets/${page}/${page}.css`));
  if (page === 'bio') css += '\n' + (await read('assets/bio/island.css'));
  else css += '\n' + (await read('assets/games/arcade.css'));
  // Shared controls stay last so both pages use one consistent switch geometry.
  css +=
    '\n' +
    commonCSS +
    '\n' +
    (await read('assets/shared/modal-panels.css')) +
    '\n' +
    (await read('assets/shared/experience.css'));
  const formattedCSS = await format(css, { parser: 'css', printWidth: 110 });
  let template = await read(`templates/${page}.html`);
  if (page === 'bio') {
    const start = template.indexOf('<svg class="sprite"'),
      end = template.indexOf('</svg>', start);
    template = template.slice(0, end) + extraIcons + template.slice(end);
    template = template.replace('{{bio-island}}', await read('templates/bio-island.html'));
  }
  template = template
    .replace('{{icons}}', sprite)
    .replace('{{game-settings}}', gameSettings)
    .replace('{{game-profile}}', await read('templates/game-profile.html'))
    .replace('{{bio-profile}}', await read('templates/bio-profile.html'))
    .replace('{{motion-picker}}', motionPicker)
    .replace('{{boot-screen}}', await read('templates/boot-screen.html'))
    .replace(`{{styles:${page}}}`, `<style>\n${formattedCSS}\n</style>`)
    .replace('{{bootstrap}}', bootstrap)
    .replace(
      `{{script:${page}}}`,
      () =>
        `<script>\nrequestAnimationFrame(() => requestAnimationFrame(() => {\n${result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}\n}));\n</script>`,
    );
  template = await embedAssets(template);
  if (/\{\{(?:asset:|script:|styles:|icons|game-|bio-island|bio-profile|motion-|boot-screen)/.test(template))
    throw new Error('Unresolved template token');
  const output = await format(template, {
    parser: 'html',
    printWidth: 110,
    htmlWhitespaceSensitivity: 'css',
    embeddedLanguageFormatting: 'off',
  });
  const filenames = page === 'bio' ? ['bio.html'] : ['games.html', 'Портал (2).html'];
  const document = output + '\n' + license + '\n';
  for (const filename of filenames) {
    await writeFile(filename + '.tmp', document);
    await rename(filename + '.tmp', filename);
    console.log(`${filename}: ${Buffer.byteLength(document).toLocaleString('en')} bytes`);
  }
}
