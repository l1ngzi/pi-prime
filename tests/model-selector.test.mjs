import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { piRoot as root, piDependency } from './pi-sdk.mjs';
const { loadExtensions } = await import(pathToFileURL(join(root, 'dist/core/extensions/loader.js')));
const { CombinedAutocompleteProvider, Container, CURSOR_MARKER, TuiMainScreen, setKeybindings, visibleWidth } = await import(piDependency('@earendil-works/pi-tui', 'dist/index.js'));
const { CustomEditor } = await import(pathToFileURL(join(root, 'dist/modes/interactive/components/custom-editor.js')));
const { InteractiveMode } = await import(pathToFileURL(join(root, 'dist/modes/interactive/interactive-mode.js')));
const { KeybindingsManager } = await import(pathToFileURL(join(root, 'dist/core/keybindings.js')));
const keybindings = new KeybindingsManager();
setKeybindings(keybindings);
const { clampThinkingLevel } = await import(piDependency('@earendil-works/pi-ai', 'dist/models.js'));
const path = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const initialSettings = { defaultProvider: 'beta', defaultModel: 'c', defaultThinkingLevel: 'medium', theme: 'dark', compaction: { enabled: false } };
const mouse = (type, y) => ({ type, button: 'left', x: 8, y, screenX: 8, screenY: y, width: 100, height: 25, shift: false, alt: false, ctrl: false });
const models = ['alpha/a', 'alpha/b', 'beta/c'].map(key => { const [provider, id] = key.split('/'); return { provider, id, name: `中文 ${id}` }; });
models[0].reasoning = true;
models[0].thinkingLevelMap = { minimal: null, medium: null, xhigh: null, max: null };
const row = (component, text) => {
  const y = component.render(100).findIndex(line => line.includes(text));
  assert.ok(y >= 0, `Missing row: ${text}`);
  return y;
};
function choose(component, text) {
  const y = row(component, text);
  component.handleMouse(mouse('press', y));
  component.handleMouse(mouse('release', y));
  component.handleMouse(mouse('click', y));
  component.handleInput('\r');
}

async function withSelector(runs, enter = ({ editor, send }) => { editor.setText('/model'); send('\r'); },
  { favorites = ['alpha/a', 'beta/c'], modelRegistry = { getAvailable: () => models } } = {}) {
  if (!Array.isArray(runs)) runs = [runs];
  const dir = mkdtempSync(join(tmpdir(), 'pi-prime-model-selector-'));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    writeFileSync(join(dir, 'pi-prime-models.json'), JSON.stringify({ favorites, order: [] }));
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(initialSettings));
    const loaded = await loadExtensions([path], process.cwd());
    assert.deepEqual(loaded.errors, []);
    const selections = [], notices = [], thinkingLevels = [];
    let activeModel = models[0], activeThinking = 'low';
    loaded.runtime.setModel = async model => {
      selections.push(model);
      activeModel = model;
      activeThinking = clampThinkingLevel(model, activeThinking);
      return true;
    };
    loaded.runtime.setThinkingLevel = level => { assert.ok(selections.length); thinkingLevels.push(level); activeThinking = level; };
    const tui = new TuiMainScreen({ rows: 35, columns: 100 });
    tui.requestRender = tui.requestImmediateRender = () => {}; // no terminal I/O; retain real input/focus dispatch
    const plain = text => text;
    const editor = new CustomEditor(tui, { borderColor: plain, selectList: {
      selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain,
    } }, keybindings);
    const autocompleteProvider = new CombinedAutocompleteProvider([{ name: 'model' }, { name: 'settings' }], dir);
    editor.setAutocompleteProvider(autocompleteProvider);
    const nativeSubmissions = [];
    const nativeSubmit = text => nativeSubmissions.push(text);
    editor.onSubmit = nativeSubmit;
    editor.onAction('app.model.select', () => nativeSubmissions.push('native model shortcut'));
    const interactive = Object.assign(Object.create(InteractiveMode.prototype), {
      ui: tui, editor, defaultEditor: editor, editorContainer: new Container(), keybindings, autocompleteProvider,
      extensionTerminalInputSubscriptions: new Set(), extensionDialogs: [], programStatus: { setBlocked() {} },
    });
    interactive.editorContainer.addChild(editor);
    tui.addChild(interactive.editorContainer);
    tui.setFocus(editor);
    const nativeUI = interactive.createExtensionUIContext();
    const send = data => tui.handleTerminalInput(data);
    let calls = 0;
    const ctx = { mode: 'tui', cwd: dir, scopedModels: [], get model() { return activeModel; }, get thinkingLevel() { return activeThinking; }, modelRegistry, ui: {
      ...nativeUI,
      notify: message => notices.push(message),
      custom: async factory => {
        calls++;
        let component, closed = false;
        const colors = [];
        const result = nativeUI.custom((tui, _theme, kb, done) => {
          component = factory(tui, {
            fg: (color, text) => { colors.push({ color, text }); return text; },
          }, kb, value => { closed = true; done(value); });
          return component;
        });
        await Promise.resolve(); // allow the real UI to mount and focus the component
        await runs[calls - 1]({ component, dir, selections, colors, runtime: loaded.runtime });
        assert.ok(closed, 'selector must finish through done()');
        return result;
      },
    } };
    const [start] = loaded.extensions[0].handlers.get('session_start');
    const [shutdown] = loaded.extensions[0].handlers.get('session_shutdown');
    await start({}, ctx);
    for (const text of ['ordinary prompt', '/settings', '/model alpha/a']) {
      interactive.editor.setText(text); send('\r');
    }
    assert.deepEqual(nativeSubmissions, ['ordinary prompt', '/settings', '/model alpha/a']);
    nativeSubmissions.length = 0;
    for (let i = 0; i < runs.length; i++) {
      if (i > 0) { // /reload resets the editor UI before firing session_shutdown/session_start
        nativeUI.setEditorComponent(undefined);
        await shutdown({}, ctx);
        assert.equal(nativeUI.getEditorComponent(), undefined);
        await start({}, ctx);
      }
      await enter({ editor: interactive.editor, send, index: i });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls, i + 1, `selector did not open; native received ${JSON.stringify(nativeSubmissions)}`);
      assert.deepEqual(nativeSubmissions, []);
      assert.equal(interactive.editor.onSubmit, nativeSubmit);
    }
    await shutdown({}, ctx);
    assert.equal(nativeUI.getEditorComponent(), undefined);
    assert.equal(interactive.editor, editor);
    return { selections, notices, thinkingLevels, settingsText: readFileSync(join(dir, 'settings.json'), 'utf8') };
  } finally {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = original;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('/model opens favorites above providers; Enter drills down, Esc returns; no extra controls', async () => {
  const result = await withSelector(({ component: c, dir, colors }) => {
    c.focused = true;
    for (const width of [1, 20, 80]) assert.ok(c.render(width).every(line => visibleWidth(line) <= width));
    assert.ok(row(c, 'a [alpha]') < row(c, 'Providers'));
    assert.ok(row(c, 'c [beta]') < row(c, 'Providers'));
    const lines = c.render(100);
    assert.equal(lines[row(c, 'a [alpha]')].indexOf('a [alpha]'), lines[row(c, '  alpha')].indexOf('alpha'));
    assert.equal(lines[row(c, 'a [alpha]')].indexOf('a [alpha]'), 2);
    assert.ok(colors.some(({ color, text }) => color === 'success' && text === '→ a [alpha]'));
    assert.ok(colors.some(({ color, text }) => color === 'success' && text === '  alpha'));
    assert.ok(!colors.some(({ color, text }) => color === 'success' && /beta/.test(text)));
    assert.doesNotMatch(c.render(100).join('\n'), /[✓★☆≡]|Alt\+|Ctrl\+P|All models/);
    choose(c, '  alpha');
    assert.match(c.render(100).join('\n'), /b \[alpha\]/);
    assert.doesNotMatch(c.render(100).join('\n'), /\[beta\]/);
    c.handleInput('\x1b');
    assert.match(c.render(100).join('\n'), /Providers/);
    choose(c, '→ alpha');
    c.handleInput('\x1b[B');
    c.handleInput('\x04'); // favorite b without any star UI
    const saved = JSON.parse(readFileSync(join(dir, 'pi-prime-models.json')));
    assert.deepEqual(saved.favorites, ['alpha/a', 'beta/c', 'alpha/b']);
    assert.equal(saved.thinking['alpha/b'], 'off');
    c.handleInput('\x1b');
    assert.ok(row(c, 'b [alpha]') < row(c, 'Providers'));
    choose(c, 'b [alpha]');
  });
  assert.equal(result.selections[0], models[1]);
  assert.deepEqual(result.notices, []);
  assert.equal(result.settingsText, JSON.stringify(initialSettings)); // Enter must not save defaults
});

test('whole-row drag reorders favorites without selecting or moving providers', async () => {
  const result = await withSelector(({ component: c, dir, selections }) => {
    const from = row(c, 'a [alpha]'), to = row(c, 'c [beta]');
    assert.equal(c.handleMouse(mouse('press', from)).capture, true);
    c.handleMouse(mouse('drag', to));
    c.handleMouse(mouse('release', to));
    c.handleMouse(mouse('click', to));
    assert.deepEqual(selections, []);
    assert.ok(row(c, 'c [beta]') < row(c, 'a [alpha]'));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'pi-prime-models.json'))).order, ['alpha/b', 'beta/c', 'alpha/a']);
    assert.ok(row(c, 'a [alpha]') < row(c, 'Providers'));
    c.handleInput('\x1b');
    assert.ok(!readdirSync(dir).some(name => name.endsWith('.tmp')));
  });
  assert.deepEqual(result.selections, []);
  assert.deepEqual(result.notices, []);
});

test('root search finds a model by ID or display name with zero favorites', async () => {
  const target = { provider: 'beta', id: 'offline-17', name: 'Needle Model' };
  const result = await withSelector(['offline-17', 'Needle'].map(query => ({ component }) => {
    const root = component.render(100).join('\n');
    assert.match(root, /Providers/);
    assert.doesNotMatch(root, /Favorites|offline-17/);
    component.handleInput(query);
    assert.match(component.render(100)[row(component, 'offline-17 [beta]')], /^→/);
    component.handleInput('\r');
  }), undefined, { favorites: [], modelRegistry: { getAvailable: () => [...models, target] } });
  assert.deepEqual(result.selections, [target, target]);
  assert.deepEqual(result.notices, []);
});

test('background refresh re-filters the open query and preserves the selected model by key', async () => {
  const updated = { ...models[1], name: 'Refreshed B' };
  const { promise, resolve } = Promise.withResolvers();
  let catalog = models, signal;
  const modelRegistry = {
    getAvailable: () => catalog,
    refresh(options) { signal = options.signal; return promise; },
  };
  const result = await withSelector(async ({ component }) => {
    assert.equal(signal.aborted, false);
    component.handleInput('alpha');
    component.handleInput('\x1b[B');
    assert.match(component.render(100)[row(component, 'b [alpha]')], /^→/);
    catalog = [models[0], { ...models[0], id: 'aa' }, updated];
    resolve();
    await promise;
    row(component, 'aa [alpha]');
    assert.match(component.render(100)[row(component, 'b [alpha]')], /^→/);
    component.handleInput('\r');
  }, undefined, { modelRegistry });
  assert.equal(signal.aborted, true);
  assert.deepEqual(result.selections, [updated]);
  assert.deepEqual(result.notices, []);
});

test('a refresh that finishes after closing skips the disposed picker', async () => {
  const { promise, resolve } = Promise.withResolvers();
  let reads = 0;
  const modelRegistry = { getAvailable() { reads++; return models; }, refresh: () => promise };
  const result = await withSelector(({ component }) => component.handleInput('\x1b'), undefined, { modelRegistry });
  resolve();
  await promise;
  assert.equal(reads, 1);
  assert.deepEqual(result.notices, []);
});

test('Right/Left edit thinking; Tab returns to top; supported levels and model-first application are preserved', async () => {
  const result = await withSelector(({ component: c, dir, selections }) => {
    c.focused = true;
    assert.ok(c.render(100).some(line => line.includes(CURSOR_MARKER)));
    c.handleInput('\x1b[C');
    assert.ok(!c.render(100).some(line => line.includes(CURSOR_MARKER)));
    assert.match(c.render(100).join('\n'), /\[low\]/);
    c.handleInput('\x1b[A'); // skip unsupported medium, advance to high
    c.handleInput('\x1b[A'); // high is the highest supported level
    assert.match(c.render(100).join('\n'), /\[high\]/);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'pi-prime-models.json'))).thinking, { 'alpha/a': 'high' });
    assert.deepEqual(selections, []);
    c.handleInput('\x1b[D');
    assert.ok(c.render(100).some(line => line.includes(CURSOR_MARKER)));
    c.handleInput('\x1b[B');
    assert.match(c.render(100)[row(c, 'c [beta]')], /^→/);
    c.handleInput('\x1b[C');
    c.handleInput('\x1b[A'); // non-reasoning model stays off, selection stays on c
    assert.match(c.render(100)[row(c, 'c [beta]')], /^→.*\[off\]/);
    c.handleInput('\t'); // leave thinking edit and return to the first model
    assert.match(c.render(100)[row(c, 'a [alpha]')], /^→/);
    assert.doesNotMatch(c.render(100).join('\n'), /\[high\]|\[off\]/);
    c.handleInput('\r');
  });
  assert.deepEqual(result.notices, []);
  assert.equal(result.selections[0], models[0]);
  assert.deepEqual(result.thinkingLevels, ['high']);
});

test('cursor-only and unhandled keys keep the selected model or provider', async () => {
  const result = await withSelector(({ component: c }) => {
    c.handleInput('\x1b[B');
    c.handleInput('\x1b[D'); // left outside thinking must not reset the list
    assert.match(c.render(100)[row(c, 'c [beta]')], /^→/);
    c.handleInput('\x1b[B');
    c.handleInput('\x1b[C'); // providers have no thinking control
    assert.ok(c.render(100).includes('→ alpha'));
    c.handleInput('\x13'); // no default model can be saved from a provider row
    assert.ok(c.render(100).includes('→ alpha'));
    c.handleInput('\r');
    c.handleInput('alpha'); // both provider models match
    c.handleInput('\x1b[B');
    for (const key of ['\x1b[D', '\x1b[C', '\x1b[15~']) {
      c.handleInput(key); // move the search cursor / unbound F5, without changing the query
      assert.match(c.render(100)[row(c, 'b [alpha]')], /^→/);
    }
    c.handleInput('\x1b');
    c.handleInput('\x1b');
  });
  assert.deepEqual(result.notices, []);
  assert.deepEqual(result.selections, []);
});

test('confirmed favorites retain their own thinking level across switches and reopening', async () => {
  const result = await withSelector([
    ({ component: c }) => c.handleInput('\r'), // confirm a + low without editing thinking
    ({ component: c }) => {
      c.handleInput('\x1b[B');
      c.handleInput('\r'); // non-reasoning c makes the session thinking off
    },
    ({ component: c }) => {
      assert.match(c.render(100)[row(c, 'a [alpha]')], / low$/);
      c.handleInput('\r');
    },
  ]);
  assert.deepEqual(result.notices, []);
  assert.deepEqual(result.selections, [models[0], models[2], models[0]]);
  assert.deepEqual(result.thinkingLevels, ['low', 'off', 'low']);
});

test('slash autocomplete and Ctrl+L open the extension after reload; Ctrl+L preserves the draft', async () => {
  const close = ({ component: c }) => {
    assert.match(c.render(100).join('\n'), /Favorites/);
    assert.match(c.render(100).join('\n'), /Providers/);
    c.handleInput('\x1b');
  };
  const result = await withSelector([close, close], async ({ editor, send, index }) => {
    if (index === 0) {
      editor.setText(''); send('/mo');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(editor.getText(), '/mo');
      assert.ok(editor.isShowingAutocomplete());
      send('\r');
    } else {
      editor.setText('unfinished prompt');
      send('\x0c');
      assert.equal(editor.getText(), 'unfinished prompt');
    }
  });
  assert.deepEqual(result.notices, []);
  assert.deepEqual(result.selections, []);
});

test('Ctrl+S directly from thinking edit saves the model and edited thinking defaults, preserving unrelated settings', async () => {
  const result = await withSelector(({ component: c }) => {
    assert.match(c.render(80).join('\n'), /Ctrl\+S default/);
    c.handleInput('\x1b[C');
    c.handleInput('\x1b[A');
    assert.match(c.render(80).join('\n'), /Ctrl\+S default/);
    c.handleInput('\x13');
  });
  assert.deepEqual(result.selections, [models[0]]);
  assert.deepEqual(result.thinkingLevels, ['high']);
  assert.deepEqual(JSON.parse(result.settingsText), { ...initialSettings, defaultProvider: 'alpha', defaultModel: 'a', defaultThinkingLevel: 'high' });
  assert.deepEqual(result.notices, ['Default model: alpha/a']);
});

test('Ctrl+S does not save a default when model authentication fails', async () => {
  const result = await withSelector(({ component: c, runtime }) => {
    runtime.setModel = async () => false;
    c.handleInput('\x13');
  });
  assert.equal(result.settingsText, JSON.stringify(initialSettings));
  assert.deepEqual(result.thinkingLevels, []);
  assert.deepEqual(result.notices, ['No authentication configured for alpha.']);
});

test('Ctrl+S reports settings parse errors without overwriting the file or claiming success', async () => {
  const result = await withSelector(({ component: c, dir }) => {
    writeFileSync(join(dir, 'settings.json'), '{broken');
    c.handleInput('\x13');
  });
  assert.equal(result.settingsText, '{broken');
  assert.deepEqual(result.selections, [models[0]]);
  assert.equal(result.notices.length, 1);
  assert.match(result.notices[0], /Could not save default model/);
});

test('an unknown saved thinking level leaves favorites usable and selects a supported level', async () => {
  const result = await withSelector([
    ({ component, dir }) => {
      writeFileSync(join(dir, 'pi-prime-models.json'), JSON.stringify({
        favorites: ['alpha/a', 'beta/c'], thinking: { 'alpha/a': 'future-level' },
      }));
      component.handleInput('\x1b');
    },
    ({ component }) => {
      row(component, 'c [beta]');
      choose(component, 'a [alpha]');
    },
  ]);
  assert.deepEqual(result.selections, [models[0]]);
  assert.deepEqual(result.thinkingLevels, [clampThinkingLevel(models[0], 'future-level')]);
});

test('invalid preferences are not overwritten by a favorite operation', async () => {
  const result = await withSelector(({ component: c, dir }) => {
    writeFileSync(join(dir, 'pi-prime-models.json'), '{broken');
    c.handleInput('\x04');
    c.handleInput('\r'); // confirming must not hide an unsaved favorite thinking level
    assert.match(c.render(100).join('\n'), /Could not save/);
    assert.equal(readFileSync(join(dir, 'pi-prime-models.json'), 'utf8'), '{broken');
    c.handleInput('\x1b');
  });
  assert.deepEqual(result.notices, []);
  assert.deepEqual(result.selections, []);
});
