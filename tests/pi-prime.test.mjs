import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAssistantMessageEventStream, getCurrentTools, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

import { piRoot } from './pi-sdk.mjs';
const { discoverAndLoadExtensions } = await import(pathToFileURL(join(piRoot, 'dist/core/extensions/loader.js')));
const { createAgentSession, createCodemodeExtension, createToolSearchExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(join(piRoot, 'dist/index.js')));
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const entryFile = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const testsDir = fileURLToPath(new URL('.', import.meta.url));

test('fresh Pi sessions use the model-specific tool surface and honor explicit selections', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-prime-fresh-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const gpt = modelRuntime.getModel('openai', 'gpt-4.1'), claude = modelRuntime.getModel('anthropic', 'claude-haiku-4-5');
  for (const model of [gpt, claude]) await modelRuntime.setRuntimeApiKey(model.provider, 'offline');

  async function checkSession(t, model, tools) {
    const settingsManager = SettingsManager.inMemory({});
    const loader = new DefaultResourceLoader({
      cwd, agentDir: cwd, settingsManager, additionalExtensionPaths: [packageRoot],
      extensionFactories: [
        { name: 'codemode', factory: createCodemodeExtension(), builtin: true, replaceable: true },
        { name: 'tool-search', factory: createToolSearchExtension(), builtin: true, replaceable: true },
        pi => pi.registerTool({ name: 'lookup', label: 'Lookup', description: 'Look up an item.', exposure: 'deferred',
          parameters: Type.Object({}), execute: async () => ({ content: [], details: undefined }) }),
      ],
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime, tools,
      resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(cwd) });
    t.after(() => session.dispose());
    await session.bindExtensions({});
    const requests = [];
    const script = `
      await tools.write({ path: "probe.txt", content: "before" });
      await tools.edit({ path: "probe.txt", edits: [{ oldText: "before", newText: "after" }] });
      text(await tools.read({ path: "probe.txt" }));`;
    session.agent.streamFunction = (_model, context) => {
      requests.push(getCurrentTools(context.messages));
      const call = model === gpt && !tools && requests.length === 1;
      const stream = createAssistantMessageEventStream();
      const stopReason = call ? 'toolUse' : 'stop';
      stream.push({ type: 'done', reason: stopReason, message: {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: 0, stopReason,
        content: call ? [{ type: 'toolCall', id: 'probe', name: 'codemode', arguments: { code: script } }] : [{ type: 'text', text: 'done' }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } });
      return stream;
    };
    await session.prompt('Check the file tools.');
    const declared = new Map(requests[0].map(tool => [tool.name, tool.description]));
    if (tools?.includes('read')) { assert.deepEqual([...declared.keys()], ['read']); return; }
    const codemode = !tools?.includes('-codemode'), only = codemode && model === gpt;
    assert.equal(declared.has('codemode'), codemode);
    assert.equal(session.getActiveToolNames().includes('tool_search'), !tools?.includes('-tool_search'));
    assert.equal(declared.has('tool_search'), !tools?.includes('-tool_search'));
    for (const name of ['read', 'edit', 'write']) {
      assert.equal(declared.has(name), !only, name);
      if (codemode) assert.equal(new RegExp(`\\b${name}\\s*\\(`).test(declared.get('codemode')), only, name);
    }
    if (only && !tools) {
      assert.equal(requests.length, 2);
      const result = session.messages.find(message => message.role === 'toolResult');
      assert.equal(result.isError, false);
      assert.match(JSON.stringify(result.content), /after/);
      assert.equal(await readFile(join(cwd, 'probe.txt'), 'utf8'), 'after');
    }
  }
  for (const [model, tools] of [[gpt], [claude], [gpt, ['-codemode']], [gpt, ['-tool_search']], [gpt, ['read']]]) {
    await t.test([model.id, ...(tools ?? ['defaults'])].join(' '), t => checkSession(t, model, tools));
  }
});

test('pi-prime registers core tools, replaces built-in codemode/tool-search without extra config, and cleans up on reload', async t => {
  const loaded = await discoverAndLoadExtensions([entryFile], testsDir, testsDir);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  const terminalTools = ['bash', 'powershell', 'exec_command', 'write_stdin', 'terminal_sessions'];
  assert.deepEqual(
    new Set(extension.tools.keys()),
    new Set(['session_recall', 'tool_search', 'codemode', 'read', 'edit', 'write', ...terminalTools]),
  );
  assert.equal(extension.toolRenderers.length, 1);
  assert.equal(extension.handlers.get('session_before_compact'), undefined);

  const cwd = await mkdtemp(join(tmpdir(), 'pi-prime-loader-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, 'edit.txt');
  await writeFile(path, 'Ａ it’s  \r\n');
  const edit = extension.tools.get('edit').definition;
  await assert.rejects(edit.execute('near-match', { path, edits: [{ oldText: 'A', newText: 'wrong' }] },
    undefined, undefined, { cwd }), /exact|match/i);
  await edit.execute('edit-loader-test', {
    path, edits: [{ oldText: 'it’s', newText: 'updated' }],
  }, undefined, undefined, { cwd });
  assert.equal(await readFile(path, 'utf8'), 'Ａ updated  \r\n');
  assert.deepEqual([...extension.commands.keys()], ['terminal']);

  // Verify zero-config replacement of Pi's built-in replaceable codemode and tool-search extensions.
  const defaultSettings = SettingsManager.inMemory({ cacheWarming: 'off', compaction: { enabled: false } });
  const defaultLoader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager: defaultSettings,
    additionalExtensionPaths: [packageRoot],
    extensionFactories: [
      { name: 'codemode', factory: createCodemodeExtension(), builtin: true, replaceable: true },
      { name: 'tool-search', factory: createToolSearchExtension(), builtin: true, replaceable: true },
    ],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await defaultLoader.reload();
  const defaultExt = defaultLoader.getExtensions();
  assert.deepEqual(defaultExt.errors, []);
  assert.equal(defaultExt.extensions.flatMap(ext => [...ext.tools.keys()]).filter(name => name === 'codemode').length, 1);
  assert.equal(defaultExt.extensions.flatMap(ext => [...ext.tools.keys()]).filter(name => name === 'tool_search').length, 1);

  // Disabling the replaced built-ins silences Pi's informational startup notices as well.
  const quietSettings = SettingsManager.inMemory({
    extensions: ['-builtin:codemode', '-builtin:tool-search'],
    cacheWarming: 'off', compaction: { enabled: false },
  });
  const quietLoader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager: quietSettings,
    additionalExtensionPaths: [packageRoot],
    extensionFactories: [
      { name: 'codemode', factory: createCodemodeExtension(), builtin: true, replaceable: true },
      { name: 'tool-search', factory: createToolSearchExtension(), builtin: true, replaceable: true },
    ],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await quietLoader.reload();
  const quietExt = quietLoader.getExtensions();
  assert.deepEqual(quietExt.errors, []);
  assert.deepEqual(quietExt.warnings, []);
  assert.equal(quietExt.extensions.flatMap(ext => [...ext.tools.keys()]).filter(name => name === 'codemode').length, 1);
  assert.equal(quietExt.extensions.flatMap(ext => [...ext.tools.keys()]).filter(name => name === 'tool_search').length, 1);

  const receipt = 'Exit 1\n{"ok":true}\nFATAL';
  let payload = { model: 'google/gemini-4-flash', messages: [{ role: 'tool', content: receipt }] };
  for (const handler of extension.handlers.get('before_provider_request') ?? []) {
    payload = (await handler({ payload }, { hasUI: false, model: { provider: 'openrouter', api: 'openai-completions' } })) ?? payload;
  }
  assert.equal(JSON.parse(payload.messages[0].content).output, receipt);

  loaded.runtime.getAllTools = () => [...extension.tools.values()].map(tool => tool.definition);
  let activeTools = ['codemode', 'tool_search'];
  loaded.runtime.getActiveTools = () => activeTools;
  loaded.runtime.setActiveTools = names => { activeTools = names; };
  const entries = [], notices = [], statuses = new Map();
  loaded.runtime.appendEntry = (customType, data) => entries.push({ type: 'custom', customType, data });
  const systemPromptOptions = { promptGuidelines: [], sections: {} };
  for (const handler of extension.handlers.get('before_agent_start') ?? []) {
    await handler({ systemPromptOptions }, { sessionManager: { getBranch: () => [] } });
  }
  assert.ok(!systemPromptOptions.promptGuidelines.some(rule => rule.includes('session_recall')));
  assert.match(systemPromptOptions.sections.execution_resources, /CPU/i);
  assert.match(systemPromptOptions.sections.execution_resources, /memory/i);
  assert.match(systemPromptOptions.sections.docs, /[/\\]README\.md\b/);

  let now = 0;
  const timers = new Set();
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setInterval', callback => {
    const timer = { callback, unref() {} };
    timers.add(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearInterval', timer => timers.delete(timer));
  const originalEditor = () => {};
  let editor = originalEditor;
  const ctx = {
    mode: 'tui', hasUI: true,
    sessionManager: { getEntries: () => entries, getBranch: () => entries, getSessionId: () => 'test-session' },
    ui: {
      getEditorComponent: () => editor,
      setEditorComponent: factory => { editor = factory; },
      notify: text => notices.push(text),
      setStatus: (key, text) => statuses.set(key, text),
      theme: { fg: (_color, text) => text, bold: text => text },
    },
  };
  const emit = async (name, event = {}) => {
    for (const handler of extension.handlers.get(name) ?? []) await handler(event, ctx);
  };
  t.after(() => emit('session_shutdown'));
  await emit('session_start');
  assert.notEqual(editor, originalEditor);
  assert.deepEqual(notices, []);
  assert.equal(timers.size, 0);

  const message = {
    role: 'assistant', provider: 'openai', api: 'openai-responses', model: 'gpt-6.1-sol',
    content: [{ type: 'text', text: 'abcdabcd' }], usage: { output: 100, reasoning: 0 }, stopReason: 'stop',
  };
  await emit('agent_start');
  await emit('turn_start');
  now = 1000;
  await emit('before_provider_request');
  assert.equal(timers.size, 1);
  await emit('message_start', { message });
  await emit('message_update', { message, assistantMessageEvent: { type: 'text_delta', delta: 'abcd' } });
  now = 1500;
  for (const timer of timers) timer.callback();
  assert.match(statuses.get('tps'), /≈2\.0 tok\/s/);
  now = 2000;
  await emit('message_update', { message, assistantMessageEvent: { type: 'text_delta', delta: 'abcd' } });
  now = 3000;
  await emit('message_end', { message });
  await emit('agent_end');
  assert.match(statuses.get('tps'), /≈2\.0 tok\/s avg · ≈2 tok · 2\.0s total/);
  assert.equal(timers.size, 0);
  assert.deepEqual(notices, []);
  assert.deepEqual(entries, []);

  await emit('agent_start');
  await emit('turn_start');
  assert.equal(timers.size, 1);
  await emit('session_shutdown');
  assert.equal(editor, originalEditor);
  assert.equal(statuses.get('tps'), undefined);
  assert.equal(timers.size, 0);
  await emit('session_start');
  assert.deepEqual(notices, []);
  assert.equal(entries.length, 0);
});
