import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [template, app, demosText, builtPage, refinements] = await Promise.all([
  readFile(new URL('../templates/bio.html', import.meta.url), 'utf8'),
  readFile(new URL('../assets/bio/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../assets/bio/demos.json', import.meta.url), 'utf8'),
  readFile(new URL('../bio.html', import.meta.url), 'utf8'),
  readFile(new URL('../assets/bio/refinements.css', import.meta.url), 'utf8'),
]);
const demos = JSON.parse(demosText);

function xliPanel(html) {
  const start = html.indexOf('id="agent-panel-xli"');
  const end = html.indexOf('id="agent-panel-xgo"', start);
  assert.notEqual(start, -1, 'XLI panel exists');
  assert.notEqual(end, -1, 'separate XGO panel follows XLI');
  return html.slice(start, end);
}

test('XLI copy matches the reviewed branch and keeps XGO separate', () => {
  const panel = xliPanel(template);
  assert.match(app, /github\.com\/ty4chka\/xli\/tree\/arena\/2bb12510-xli/);
  assert.match(app, /265f0a45/);
  assert.match(panel, /XGO в эту архитектуру не входит/);
  assert.match(template, /XLI — coding agent на Python; XGO — отдельный Telegram AI-проект/);
  for (const staleClaim of [
    /XGO Agent/,
    /XLI Bot/,
    /Textual/,
    /пятью агентами/,
    /14 подсистем/,
    /SafeShell/,
    /go test/,
    /xli --task/,
    /~\/go\/src\/worker/,
  ]) {
    assert.doesNotMatch(panel, staleClaim);
  }
});

test('XLI interface controls and documented demos stay in sync', () => {
  const modes = [...template.matchAll(/data-interface="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(modes, ['cli', 'tui', 'nvim', 'kernel']);
  for (const mode of modes) assert.match(app, new RegExp(`\\b${mode}: \\{`));
  assert.match(app, /agent-pill-gradient/);
  assert.match(app, /dataset\.switching = 'true'/);
  assert.match(refinements, /fill: url\(#agent-pill-gradient\)/);
  assert.match(refinements, /@keyframes agent-pill-arrive/);

  const subsystemIds = ['tool-calls', 'layers', 'autonomy', 'reconciler', 'xpi', 'tui'];
  for (const language of ['ru', 'en']) {
    assert.deepEqual(
      demos[language].SUBSYSTEMS.map(({ id }) => id),
      subsystemIds,
    );
    for (const script of [
      demos[language].xliTerminalScripts,
      demos[language].tuiScripts,
      demos[language].nvimScripts,
      demos[language].kernelScripts,
      demos[language].policyScripts,
    ]) {
      assert.ok(
        script.some((step) =>
          /static|статическ|preview|предпросмотр|illustration|иллюстрац/i.test(step.text || ''),
        ),
      );
    }
    assert.doesNotMatch(JSON.stringify(demos[language].xliTerminalScripts), /go test|PASS|passed|XGO Agent/i);
  }
  for (const id of subsystemIds) assert.match(template, new RegExp(`data-system="${id}"`));
  assert.match(builtPage, /Что обновлено к 265f0a4/);
});
