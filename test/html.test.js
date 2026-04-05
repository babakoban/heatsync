'use strict';
// Static analysis tests for HTML files.
// Validates that the template and generated outputs contain all required
// structure: screens, zone cards, inputs, buttons, and platform separation.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');

// ─── File loading ─────────────────────────────────────────────────────────────

const ROOT     = path.join(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'views', 'game.html');
const WEB      = path.join(ROOT, 'public', 'index.html');
const ELECTRON = path.join(ROOT, 'electron-app', 'index.html');

const template = fs.readFileSync(TEMPLATE, 'utf8');
const webHtml  = fs.readFileSync(WEB,      'utf8');
const electronHtml = fs.readFileSync(ELECTRON, 'utf8');

// ─── Mini helpers ─────────────────────────────────────────────────────────────

function hasId(html, id) {
  return html.includes(`id="${id}"`) || html.includes(`id='${id}'`);
}

function hasDataAttr(html, attr, value) {
  return html.includes(`${attr}="${value}"`) || html.includes(`${attr}='${value}'`);
}

// ─── Template ─────────────────────────────────────────────────────────────────

describe('template (views/game.html)', () => {
  test('file is non-empty', () => {
    assert.ok(template.length > 500);
  });

  test('starts with <!DOCTYPE html>', () => {
    assert.ok(template.trimStart().startsWith('<!DOCTYPE html>'));
  });

  // ── Screens ──
  const SCREENS = [
    'screen-landing',
    'screen-lobby',
    'screen-allocation',
    'screen-reveal',
    'screen-gameover',
  ];
  for (const id of SCREENS) {
    test(`contains screen #${id}`, () => {
      assert.ok(hasId(template, id), `Missing screen #${id}`);
    });
  }

  // ── Zone cards ──
  for (const zone of ['docks', 'strip', 'slums']) {
    test(`contains zone card data-zone="${zone}"`, () => {
      assert.ok(hasDataAttr(template, 'data-zone', zone), `Missing zone card for ${zone}`);
    });
  }

  // ── Inputs ──
  for (const id of ['create-name', 'join-name', 'join-code']) {
    test(`contains input #${id}`, () => {
      assert.ok(hasId(template, id), `Missing input #${id}`);
    });
  }

  // ── Buttons ──
  for (const id of ['btn-start', 'btn-submit']) {
    test(`contains button #${id}`, () => {
      assert.ok(hasId(template, id), `Missing button #${id}`);
    });
  }

  test('contains lobby code display #lobby-code-text', () => {
    assert.ok(hasId(template, 'lobby-code-text'));
  });

  test('contains allocation remaining counter #remaining-count', () => {
    assert.ok(hasId(template, 'remaining-count'));
  });

  test('contains gameover standings #gameover-standings', () => {
    assert.ok(hasId(template, 'gameover-standings'));
  });

  // ── Platform markers are balanced ──
  test('[WEB] markers are balanced', () => {
    const opens  = (template.match(/<!--\[WEB\]-->/g)    || []).length;
    const closes = (template.match(/<!--\[\/WEB\]-->/g)  || []).length;
    assert.equal(opens, closes, `WEB marker mismatch: ${opens} opens vs ${closes} closes`);
  });

  test('[ELECTRON] markers are balanced', () => {
    const opens  = (template.match(/<!--\[ELECTRON\]-->/g)   || []).length;
    const closes = (template.match(/<!--\[\/ELECTRON\]-->/g) || []).length;
    assert.equal(opens, closes);
  });

  test('contains at least one [WEB]-only block', () => {
    assert.ok(template.includes('<!--[WEB]-->'));
  });

  test('contains at least one [ELECTRON]-only block', () => {
    assert.ok(template.includes('<!--[ELECTRON]-->'));
  });
});

// ─── Generated web HTML ───────────────────────────────────────────────────────

describe('generated web HTML (public/index.html)', () => {
  test('starts with <!DOCTYPE html>', () => {
    assert.ok(webHtml.trimStart().startsWith('<!DOCTYPE html>'));
  });

  test('DOCTYPE comes before any HTML comment (no quirks mode)', () => {
    const doctypePos = webHtml.indexOf('<!DOCTYPE html>');
    const commentPos = webHtml.indexOf('<!--');
    assert.ok(doctypePos < commentPos, 'DOCTYPE must precede the first comment');
  });

  test('does not contain platform markers', () => {
    assert.ok(!webHtml.includes('[WEB]'),      'Should not contain raw [WEB] markers');
    assert.ok(!webHtml.includes('[ELECTRON]'), 'Should not contain raw [ELECTRON] markers');
  });

  test('includes socket.io script tag', () => {
    assert.ok(webHtml.includes('socket.io'), 'Web build should include socket.io client');
  });

  test('loads client.js (not client-p2p.js)', () => {
    assert.ok(webHtml.includes('client.js'));
    assert.ok(!webHtml.includes('client-p2p.js'));
  });

  test('contains all required game screens', () => {
    for (const id of ['screen-landing', 'screen-lobby', 'screen-allocation', 'screen-reveal', 'screen-gameover']) {
      assert.ok(hasId(webHtml, id), `Web HTML missing screen #${id}`);
    }
  });

  test('contains all three zone cards', () => {
    for (const zone of ['docks', 'strip', 'slums']) {
      assert.ok(hasDataAttr(webHtml, 'data-zone', zone), `Missing zone ${zone}`);
    }
  });

  test('contains submit button', () => {
    assert.ok(hasId(webHtml, 'btn-submit'));
  });

  test('does not contain Electron-only resume banner', () => {
    // The resume-banner is ELECTRON-only
    assert.ok(!webHtml.includes('btn-resume-yes'));
  });
});

// ─── Generated Electron HTML ──────────────────────────────────────────────────

describe('generated electron HTML (electron-app/index.html)', () => {
  test('starts with <!DOCTYPE html>', () => {
    assert.ok(electronHtml.trimStart().startsWith('<!DOCTYPE html>'));
  });

  test('DOCTYPE comes before any HTML comment', () => {
    const doctypePos = electronHtml.indexOf('<!DOCTYPE html>');
    const commentPos = electronHtml.indexOf('<!--');
    assert.ok(doctypePos < commentPos);
  });

  test('does not contain platform markers', () => {
    assert.ok(!electronHtml.includes('[WEB]'));
    assert.ok(!electronHtml.includes('[ELECTRON]'));
  });

  test('does not load socket.io CDN script', () => {
    assert.ok(!electronHtml.includes('/socket.io/socket.io.js'));
  });

  test('loads client-p2p.js (not plain client.js)', () => {
    assert.ok(electronHtml.includes('client-p2p.js'));
  });

  test('references local style.css (not CDN)', () => {
    assert.ok(electronHtml.includes('style.css'));
    assert.ok(!electronHtml.includes('googleapis.com'), 'Electron build should not load Google Fonts');
  });

  test('contains all required game screens', () => {
    for (const id of ['screen-landing', 'screen-lobby', 'screen-allocation', 'screen-reveal', 'screen-gameover']) {
      assert.ok(hasId(electronHtml, id), `Electron HTML missing screen #${id}`);
    }
  });

  test('contains all three zone cards', () => {
    for (const zone of ['docks', 'strip', 'slums']) {
      assert.ok(hasDataAttr(electronHtml, 'data-zone', zone));
    }
  });

  test('contains Electron-only resume banner', () => {
    assert.ok(electronHtml.includes('btn-resume-yes'));
  });

  test('does not contain web-only font preconnect links', () => {
    assert.ok(!electronHtml.includes('fonts.googleapis.com'));
  });
});

// ─── Build script consistency ─────────────────────────────────────────────────

describe('build-html script consistency', () => {
  test('build script exists', () => {
    const scriptPath = path.join(ROOT, 'scripts', 'build-html.js');
    assert.ok(fs.existsSync(scriptPath));
  });

  // Inline the same transform logic as build-html.js so we can compare without
  // writing files. The DO NOT EDIT header is multiline, so we strip it with
  // a dotAll regex before comparing.
  function buildPlatform(tmpl, platform) {
    const keep = platform === 'web' ? 'WEB' : 'ELECTRON';
    const drop = platform === 'web' ? 'ELECTRON' : 'WEB';
    let out = tmpl.replace(
      new RegExp(`[ \\t]*<!--\\[${drop}\\]-->[\\s\\S]*?<!--\\[\\/${drop}\\]-->[ \\t]*\\n?`, 'g'),
      ''
    );
    out = out.replace(new RegExp(`[ \\t]*<!--\\[${keep}\\]-->[ \\t]*\\n?`, 'g'), '');
    out = out.replace(new RegExp(`[ \\t]*<!--\\[\\/${keep}\\]-->[ \\t]*\\n?`, 'g'), '');
    out = out.replace(/\n{3,}/g, '\n\n');
    return out.trimStart();
  }

  // Strips the "DO NOT EDIT" header (which spans two lines) so we can compare
  // the content without caring about the header text.
  const headerRe = /<!-- DO NOT EDIT[\s\S]*?-->\n/;

  test('regenerated web output matches existing public/index.html', () => {
    const generated = buildPlatform(template, 'web');
    const stripped  = webHtml.replace(headerRe, '');
    assert.equal(
      generated, stripped,
      'public/index.html is out of sync with views/game.html — run npm run build-html'
    );
  });

  test('regenerated electron output matches existing electron-app/index.html', () => {
    const generated = buildPlatform(template, 'electron');
    const stripped  = electronHtml.replace(headerRe, '');
    assert.equal(
      generated, stripped,
      'electron-app/index.html is out of sync — run npm run build-html'
    );
  });
});
