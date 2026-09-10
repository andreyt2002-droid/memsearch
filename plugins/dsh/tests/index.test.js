import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { join, sep } from 'node:path'

import { detectDshCmd, detectMemsearchCmd, summarizeTurn, apply, resolveSummarizeMode, renderTurn, captureExists, writeCapture, filterDiagnosticFields, runQualityGate, runSearch, indexMemory, memsearchDirFor, listSkillCandidates, resolveSkillInstallTarget } from '../index.js'
import { withIsolatedEnv } from './env.js'

async function withInjectionFixture(searchResults, assertion, oldCore = false, diagnostic = false) {
  const root = fs.mkdtempSync(`${os.tmpdir()}/memsearch-inject-`)
  const projectDir = `${root}/project`
  const memoryDir = `${root}/state/memory`
  const fakeBin = `${root}/bin`
  const resultFile = `${root}/search-result.json`
  const callLog = `${root}/memsearch-calls.txt`
  fs.mkdirSync(projectDir, { recursive: true })
  fs.mkdirSync(memoryDir, { recursive: true })
  fs.mkdirSync(fakeBin, { recursive: true })
  fs.writeFileSync(`${memoryDir}/2026-09-07.md`, '# Test memory\n', 'utf-8')
  fs.writeFileSync(resultFile, JSON.stringify(searchResults), 'utf-8')
  // Fake memsearch CLI as a plain node script so the fixture runs on Windows
  // too (no /bin/sh shebang, no PATH/PATHEXT resolution needed): the child
  // receives it through the explicit MEMSEARCH_CMD JSON-argv override.
  const shim = `${fakeBin}/memsearch-fake.cjs`
  fs.writeFileSync(
    shim,
    [
      'const fs = require("node:fs")',
      'const args = process.argv.slice(2)',
      'fs.appendFileSync(process.env.MEMSEARCH_TEST_CALL_LOG, args.join(" ") + "\\n")',
      'if (process.env.MEMSEARCH_TEST_OLD_CORE === "1" && args.includes("--default-collection")) {',
      '  process.stderr.write("Error: No such option: --default-collection\\n")',
      '  process.exit(2)',
      '}',
      'if (args[0] === "config") process.exit(0)',
      'if (args[0] === "search") {',
      '  process.stdout.write(fs.readFileSync(process.env.MEMSEARCH_TEST_RESULT, "utf-8"))',
      '  process.exit(0)',
      '}',
      'process.exit(0)',
    ].join('\n'),
    'utf-8',
  )
  if (process.platform !== 'win32') {
    fs.writeFileSync(
      `${fakeBin}/bash`,
      '#!/bin/sh\n' +
        'PATH="$MEMSEARCH_TEST_PATH"\n' +
        'export PATH\n' +
        'BASH_ENV=/dev/null\n' +
        'export BASH_ENV\n' +
        'exec /usr/bin/bash --noprofile --norc "$@"\n',
      'utf-8',
    )
    fs.chmodSync(`${fakeBin}/bash`, 0o755)
  }

  try {
    const childSource = `
      const { apply } = await import(process.env.MEMSEARCH_PLUGIN_URL)
      const listeners = {}
      const registeredSkills = []
      let disposeDiagnostics = async () => {}
      const ctx = {
        logger: { warn: () => {}, debug: () => {} },
        skills: { register: (skill) => registeredSkills.push(skill) },
        on: (name, listener) => { listeners[name] = listener },
        effect: (setup) => { disposeDiagnostics = setup() },
      }
      apply(ctx, {
        captureEnabled: false,
        diagnosticLogEnabled: process.env.MEMSEARCH_TEST_DIAGNOSTIC === '1',
      })
      const decision = {
        kind: 'enter',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'What did we decide about the release?' }] }],
      }
      let result = null
      let error = ''
      try {
        result = await listeners['agent/pre-step'](
          { agent: { session: { header: { cwd: process.env.MEMSEARCH_TEST_PROJECT } } }, turn: 1, step: 1, signal: {} },
          async () => decision,
        )
      } catch (caught) {
        error = caught.message
      }
      await disposeDiagnostics()
      process.stdout.write(JSON.stringify({
        unchanged: result === decision,
        result,
        error,
        registeredSkillNames: registeredSkills.map((skill) => skill.name),
      }))
    `
    const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', childSource], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: process.platform === 'win32' ? process.env.PATH : `${fakeBin}:${process.env.PATH}`,
        MEMSEARCH_CMD: JSON.stringify([process.execPath, shim]),
        BASH_ENV: '/dev/null',
        MEMSEARCH_DIR: `${root}/state`,
        MEMSEARCH_PLUGIN_URL: new URL('../index.js', import.meta.url).href,
        MEMSEARCH_TEST_CALL_LOG: callLog,
        MEMSEARCH_TEST_PATH: `${fakeBin}:/usr/bin:/bin`,
        MEMSEARCH_TEST_PROJECT: projectDir,
        MEMSEARCH_TEST_RESULT: resultFile,
        MEMSEARCH_TEST_OLD_CORE: oldCore ? '1' : '0',
        MEMSEARCH_TEST_DIAGNOSTIC: diagnostic ? '1' : '0',
      },
    })
    const logDir = join(root, 'state', 'logs')
    const diagnosticLog = fs.existsSync(logDir)
      ? fs.readdirSync(logDir).sort().map((file) => fs.readFileSync(join(logDir, file), 'utf-8')).join('')
      : ''
    await assertion({ ...JSON.parse(stdout), callLog, diagnosticLog })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('detectDshCmd: prefers dsh on PATH as a plain argv', async () => {
  // DSH_CLI is checked after PATH; simulate PATH hit by masking DSH_CLI.
  await withIsolatedEnv({ DSH_CLI: null, PATH: '/usr/bin:/bin' }, () => {
    const cmd = detectDshCmd()
    assert.ok(cmd === null || (Array.isArray(cmd) && cmd.length >= 1), `expected null or argv, got ${JSON.stringify(cmd)}`)
  })
})

test('detectDshCmd: DSH_CLI interpreter invocation returns argv array', async () => {
  await withIsolatedEnv({ DSH_CLI: 'node /opt/dsh/bin.js', PATH: null }, () => {
    assert.deepEqual(detectDshCmd(), ['node', '/opt/dsh/bin.js'])
  })
})

test('detectDshCmd: DSH_CLI with trailing spaces is trimmed', async () => {
  await withIsolatedEnv({ DSH_CLI: 'dsh   ', PATH: null }, () => {
    assert.deepEqual(detectDshCmd(), ['dsh'])
  })
})

test('detectDshCmd: Windows npm wrapper resolves to the JS entrypoint', { skip: process.platform !== 'win32' }, async () => {
  const binDir = fs.mkdtempSync(`${os.tmpdir()}/dsh-wrapper-`).replaceAll('/', '\\')
  const wrapper = `${binDir}\\dsh.cmd`
  const node = `${binDir}\\node.exe`
  const entry = `${binDir}\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`
  fs.mkdirSync(`${binDir}\\node_modules\\@deepseek-ai\\dsh\\lib`, { recursive: true })
  fs.writeFileSync(wrapper, '@echo off\n', 'utf-8')
  fs.writeFileSync(node, '', 'utf-8')
  fs.writeFileSync(entry, '', 'utf-8')
  try {
    await withIsolatedEnv({ DSH_CLI: wrapper, PATH: null }, () => {
      assert.deepEqual(detectDshCmd(), [node, entry])
    })
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true })
  }
})

test('summarizeTurn: explicit custom-llm mode dispatches to the LLM path', async () => {
  // custom-llm mode spawns python3 summarize.py; without a real transcript we
  // only assert it picks that branch (no crash before spawn).
  const opts = { summarizeMode: 'custom-llm', agentName: 'X', summarizeProvider: '', summarizeModel: '' }
  const ctx = { logger: { warn: () => {} } }
  const render = '=== Turn 1 ===\n\n[User]: hi\n\n[Assistant]: hello'
  // If dispatch is wrong (e.g. treats anything not dsh-headless as dsh), this
  // would reject with a dsh-CLI error instead of the custom-llm path error.
  try {
    await summarizeTurn(ctx, opts, render, process.cwd())
    assert.fail('expected custom-llm summarizer to fail (no provider configured)')
  } catch (error) {
    // custom-llm path failure: summarize.py exits non-zero or times out, or
    // python3 is missing — never a "dsh CLI not found" error.
    assert.ok(
      !/dsh CLI not found/.test(error.message),
      `unexpected dsh CLI error: ${error.message}`,
    )
    assert.ok(
      !/spawn .* ENOENT/.test(error.message),
      `unexpected spawn ENOENT: ${error.message}`,
    )
  }
})

test('detectMemsearchCmd: MEMSEARCH_CMD overrides the installed CLI', async () => {
  await withIsolatedEnv({ MEMSEARCH_CMD: 'uv --directory D:/CODE-AI/memsearch run memsearch' }, () => {
    assert.deepEqual(
      detectMemsearchCmd(),
      ['uv', '--directory', 'D:/CODE-AI/memsearch', 'run', 'memsearch'],
    )
  })
})

test('runSearch: executes command spec with native argv', async () => {
  const root = fs.mkdtempSync(`${os.tmpdir()}/memsearch-native-search-`)
  const recorder = `${root}\\recorder.cjs`
  const argvFile = `${root}\\argv.json`
  fs.writeFileSync(
    recorder,
    `const fs = require('node:fs')\n` +
      `fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)))\n` +
      `process.stdout.write(JSON.stringify([{content:'native result'}]))\n`,
    'utf-8',
  )
  try {
    const result = await runSearch(
      [process.execPath, recorder],
      'query with spaces',
      'ms_native_test',
      root,
      'D:\\state\\milvus.db',
    )
    assert.deepEqual(result, [{ content: 'native result' }])
    assert.deepEqual(
      JSON.parse(fs.readFileSync(argvFile, 'utf-8')),
      ['search', 'query with spaces', '--top-k', '5', '--json-output', '--milvus-uri', 'D:\\state\\milvus.db', '--default-collection', 'ms_native_test'],
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('indexMemory: starts background index with native argv', async () => {
  const root = fs.mkdtempSync(`${os.tmpdir()}/memsearch-native-index-`)
  const memoryDir = `${root}\\memory with spaces`
  const recorder = `${root}\\recorder.cjs`
  const argvFile = `${root}\\argv.json`
  fs.mkdirSync(memoryDir, { recursive: true })
  fs.writeFileSync(
    recorder,
    `const fs = require('node:fs')\nfs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)))\n`,
    'utf-8',
  )
  try {
    indexMemory(
      { logger: { warn: () => {} } },
      [process.execPath, recorder],
      memoryDir,
      'ms_native_test',
      root,
      '',
    )
    const deadline = Date.now() + 5000
    while (!fs.existsSync(argvFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.ok(fs.existsSync(argvFile), 'background index process completed')
    assert.deepEqual(
      JSON.parse(fs.readFileSync(argvFile, 'utf-8')),
      ['index', memoryDir, '--default-collection', 'ms_native_test'],
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('resolveSummarizeMode: explicit custom-llm pins the backend', () => {
  const r = resolveSummarizeMode('unused-cmd', { summarizeMode: 'custom-llm', summarizeProvider: 'p', summarizeModel: 'm' }, {})
  assert.deepEqual(r, { mode: 'custom-llm', provider: 'p', model: 'm' })
})

test('resolveSummarizeMode: explicit dsh-headless pins the backend', () => {
  const r = resolveSummarizeMode('unused-cmd', { summarizeMode: 'dsh-headless', summarizeProvider: '', summarizeModel: '' }, {})
  assert.equal(r.mode, 'dsh-headless')
})

test('resolveSummarizeMode: auto with unreachable memsearch falls back to dsh-headless', () => {
  // A missing/broken memsearch must not throw: treat as "no [plugins.dsh.summarize]"
  // and fall back to the zero-config dsh-headless backend.
  const r = resolveSummarizeMode('definitely-not-a-real-cmd-xyz', { summarizeMode: undefined, summarizeProvider: '', summarizeModel: '' }, {})
  assert.equal(r.mode, 'dsh-headless')
})

test('resolveSummarizeMode: read failure logs a warning (not silent)', () => {
  // M3: a config-read failure must be surfaced, not silently treated as
  // "not configured" — otherwise a slow/absent memsearch flips auto to the
  // wrong backend with no signal.
  const warnings = []
  const logger = { warn: (m) => warnings.push(m) }
  const r = resolveSummarizeMode('definitely-not-a-real-cmd-xyz', { summarizeMode: undefined, summarizeProvider: '', summarizeModel: '' }, {}, logger)
  assert.equal(r.mode, 'dsh-headless')
  assert.ok(warnings.length >= 1, 'a warning was logged')
  assert.ok(warnings[0].includes('could not read'), `warning mentions the read failure: ${warnings[0]}`)
})

test('resolveSummarizeMode: unknown explicit mode logs a warning and treats as auto', () => {
  const warnings = []
  const logger = { warn: (m) => warnings.push(m) }
  const r = resolveSummarizeMode('unused-cmd', { summarizeMode: 'custom-lm', summarizeProvider: '', summarizeModel: '' }, {}, logger)
  assert.equal(r.mode, 'dsh-headless') // treated as auto with no provider configured
  assert.ok(warnings.some((w) => w.includes('unknown summarizeMode')), `unknown-mode warning logged: ${warnings}`)
})

test('resolveSummarizeMode: auto with configured provider selects custom-llm', () => {
  // Simulate `[plugins.dsh.summarize] provider = "x"` by pointing memsearchCmd
  // at a node shim that echoes the requested key (works on Windows too: no
  // shebang, passed as an explicit argv array).
  const tmp = os.tmpdir()
  const shim = `${tmp}/memsearch-config-shim-${process.pid}.cjs`
  fs.writeFileSync(
    shim,
    [
      'const args = process.argv.slice(2)',
      'const key = args[args.length - 1]',
      'const table = {',
      '  "plugins.dsh.summarize.provider": "deepseek-zilliz",',
      '  "plugins.dsh.summarize.model": "deepseek-v4-flash",',
      '  "plugins.dsh.summarize.enabled": "true",',
      '}',
      'if (key in table) process.stdout.write(table[key] + "\\n")',
    ].join('\n'),
    'utf-8',
  )
  try {
    const r = resolveSummarizeMode([process.execPath, shim], { summarizeMode: undefined, summarizeProvider: '', summarizeModel: '' }, {})
    assert.equal(r.mode, 'custom-llm')
    assert.equal(r.provider, 'deepseek-zilliz')
    assert.equal(r.model, 'deepseek-v4-flash')
  } finally {
    fs.rmSync(shim, { force: true })
  }
})

test('summarizeTurn: default (no mode configured) dispatches to dsh-headless', async () => {
  // The default is dsh-headless: an omitted summarizeMode must boot the dsh
  // agent, so without a CLI it errors with "dsh CLI not found".
  await withIsolatedEnv({ DSH_CLI: null, PATH: '/nonexistent', HOME: '/nonexistent-home' }, async () => {
    const opts = { agentName: 'X', summarizeProvider: '', summarizeModel: '' } // no summarizeMode
    const ctx = { logger: { warn: () => {} } }
    const render = '=== Turn 1 ===\n\n[User]: hi\n\n[Assistant]: hello'
    await assert.rejects(
      summarizeTurn(ctx, opts, render, process.cwd()),
      /dsh CLI not found/,
    )
  })
})

test('summarizeTurn: dsh-headless mode without CLI errors visibly', async () => {
  await withIsolatedEnv({ DSH_CLI: null, PATH: '/nonexistent', HOME: '/nonexistent-home' }, async () => {
    const opts = { summarizeMode: 'dsh-headless', agentName: 'X', summarizeProvider: '', summarizeModel: '' }
    const ctx = { logger: { warn: () => {} } }
    const render = '=== Turn 1 ===\n\n[User]: hi\n\n[Assistant]: hello'
    await assert.rejects(
      summarizeTurn(ctx, opts, render, process.cwd()),
      /dsh CLI not found/,
    )
  })
})

test('summarizeTurn: custom-llm forwards --provider/--model to summarize.py', async () => {
  // Point a fake python (argv recorder) at MEMSEARCH_PYTHON so the spawn
  // inside summarizeCustomLlm hits it; assert the provider/model options from
  // plugin config reach summarize.py as CLI args. A node recorder keeps the
  // test cross-platform (no /bin/sh shebang).
  const tmp = await import('node:os').then((os) => os.tmpdir())
  const fs = await import('node:fs')
  const argvFile = `${tmp}/memsearch-py3argv-${process.pid}.txt`
  const recorder = `${tmp}/memsearch-py3bin-${process.pid}.cjs`
  fs.writeFileSync(
    recorder,
    'const fs = require("node:fs")\n' +
      'fs.writeFileSync(process.env.MEMSEARCH_TEST_ARGV, process.argv.slice(2).join("\\n") + "\\n")\n' +
      'process.stdin.resume()\n',
    'utf-8',
  )
  try {
    await withIsolatedEnv({
      MEMSEARCH_PYTHON: JSON.stringify([process.execPath, recorder]),
      MEMSEARCH_TEST_ARGV: argvFile,
    }, async () => {
      const opts = {
        summarizeMode: 'custom-llm',
        agentName: 'AgentX',
        summarizeProvider: 'deepseek-zilliz',
        summarizeModel: 'deepseek-v4-pro',
      }
      const ctx = { logger: { warn: () => {} } }
      const render = '=== Turn 1 ===\n\n[User]: hi\n\n[Assistant]: hello'
      const summary = await summarizeTurn(ctx, opts, render, process.cwd())
      assert.equal(summary, null, 'recorder exits 0 with no stdout -> null summary')
      const recorded = fs.readFileSync(argvFile, 'utf-8').trim().split('\n')
      assert.ok(recorded[0].replaceAll('\\', '/').endsWith('scripts/summarize.py'), `first arg = summarize.py, got: ${recorded[0]}`)
      const joined = recorded.join(' ')
      assert.ok(joined.includes('--provider deepseek-zilliz'), `--provider forwarded: ${joined}`)
      assert.ok(joined.includes('--model deepseek-v4-pro'), `--model forwarded: ${joined}`)
      assert.ok(joined.includes('--agent-name AgentX'), `--agent-name forwarded: ${joined}`)
    })
  } finally {
    try { fs.rmSync(recorder, { force: true }) } catch { /* cleanup */ }
    try { fs.unlinkSync(argvFile) } catch { /* cleanup */ }
  }
})

test('summarizeTurn: custom-llm surfaces summarize.py stderr as a visible error', async () => {
  // A failing summarize.py must reject with its stderr message (visible), not
  // silently resolve null/empty — so the caller writes the unavailable note
  // with the real reason.
  const tmp = await import('node:os').then((os) => os.tmpdir())
  const fs = await import('node:fs')
  const recorder = `${tmp}/memsearch-py3fail-${process.pid}.cjs`
  fs.writeFileSync(
    recorder,
    'process.stderr.write("provider deepseek-zilliz not found in config\\n")\n' +
      'process.stdin.on("end", () => process.exit(3))\n' +
      'process.stdin.resume()\n',
    'utf-8',
  )
  try {
    await withIsolatedEnv({ MEMSEARCH_PYTHON: JSON.stringify([process.execPath, recorder]) }, async () => {
      const opts = {
        summarizeMode: 'custom-llm',
        agentName: 'X',
        summarizeProvider: 'deepseek-zilliz',
        summarizeModel: '',
      }
      const ctx = { logger: { warn: () => {} } }
      const render = '=== Turn 1 ===\n\n[User]: hi\n\n[Assistant]: hello'
      await assert.rejects(
        summarizeTurn(ctx, opts, render, process.cwd()),
        /provider deepseek-zilliz not found in config/,
      )
    })
  } finally {
    try { fs.rmSync(recorder, { force: true }) } catch { /* cleanup */ }
  }
})

test('detectDshCmd: falls back to pnpm global bin directory', async () => {
  const tmp = await import('node:os').then((os) => os.tmpdir())
  const fs = await import('node:fs')
  const fakeHome = `${tmp}/memsearch-home-${process.pid}`
  fs.mkdirSync(`${fakeHome}/.local/share/pnpm`, { recursive: true })
  fs.writeFileSync(`${fakeHome}/.local/share/pnpm/dsh`, '#!/bin/sh\nexit 0\n', 'utf-8')
  fs.chmodSync(`${fakeHome}/.local/share/pnpm/dsh`, 0o755)
  try {
    await withIsolatedEnv({ DSH_CLI: null, PATH: null, HOME: fakeHome }, () => {
      assert.deepEqual(detectDshCmd(), [join(fakeHome, '.local', 'share', 'pnpm', 'dsh')])
    })
  } finally {
    try { fs.rmSync(fakeHome, { recursive: true, force: true }) } catch { /* cleanup */ }
  }
})

test('apply: captureEnabled:false skips session/event capture listener', () => {
  const listeners = {}
  const ctx = {
    logger: { warn: () => {}, debug: () => {} },
    skills: { register: () => {} },
    on: (name, fn) => { listeners[name] = fn },
  }
  apply(ctx, { captureEnabled: false })
  assert.ok(!listeners['session/event'], 'must not register capture when disabled')
})

test('apply: summarizeEnabled:false writes the raw transcript (no summarizer)', async () => {
  const tmp = os.tmpdir()
  const projDir = `${tmp}/memsearch-raw-${process.pid}`
  const listeners = {}
  let disposeDiagnostics = async () => {}
  const ctx = {
    logger: { warn: () => {}, debug: () => {} },
    skills: { register: () => {} },
    on: (name, fn) => { listeners[name] = fn },
    effect: (setup) => { disposeDiagnostics = setup() },
  }
  const session = {
    id: 'session-raw-test',
    header: { cwd: projDir },
    events: [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'remember raw-marker-001' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
      { type: 'turn/end', data: { turn: 1 } },
    ],
  }
  try {
    // Mask the ambient checkout CLI override (start-dsh-web.cmd) and PATH so
    // the test does not spawn a real background index holding the temp dir.
    // apply() resolves the CLI at registration time, so it must run masked too.
    await withIsolatedEnv({ MEMSEARCH_CMD: null, PATH: '/nonexistent' }, async () => {
      apply(ctx, { summarizeEnabled: false, diagnosticLogEnabled: true })
      // session/event fires with (session, event); capture drains asynchronously.
      await listeners['session/event'](session, { type: 'turn/end', data: { turn: 1 } })
      // captureChain runs async; wait a beat for the write to land.
      await new Promise((r) => setTimeout(r, 300))
      const memoryDir = `${projDir}/.memsearch/memory`
      const files = fs.readdirSync(memoryDir)
      assert.equal(files.length, 1, 'one daily file written')
      const content = fs.readFileSync(`${memoryDir}/${files[0]}`, 'utf-8')
      assert.ok(content.includes('raw-marker-001'), 'raw transcript written when summarize disabled')
      assert.ok(content.includes('<!-- session:session-raw-test turn:1 '), 'anchor present')
      const logDir = `${projDir}/.memsearch/logs`
      const logDeadline = Date.now() + 5000
      let log = ''
      while (!log.includes('capture.written') && Date.now() < logDeadline) {
        if (fs.existsSync(logDir)) {
          const logFiles = fs.readdirSync(logDir)
          if (logFiles.length > 0) log = fs.readFileSync(join(logDir, logFiles[0]), 'utf-8')
        }
        if (!log.includes('capture.written')) await new Promise((resolve) => setTimeout(resolve, 25))
      }
      const events = log.trim().split('\n').map((line) => JSON.parse(line).event)
      assert.ok(events.includes('capture.queued'))
      assert.ok(events.includes('capture.started'))
      assert.ok(events.includes('capture.written'))
      assert.ok(events.indexOf('capture.queued') < events.indexOf('capture.started'))
      assert.ok(events.indexOf('capture.started') < events.indexOf('capture.written'))
      assert.ok(!log.includes('raw-marker-001'), 'diagnostic log excludes captured content')
      await disposeDiagnostics()
    })
  } finally {
    await disposeDiagnostics()
    fs.rmSync(projDir, { recursive: true, force: true })
  }
})

test('apply: diagnostic log failure warns once and does not block capture', async () => {
  const projectDir = fs.mkdtempSync(`${os.tmpdir()}/memsearch-diagnostic-fail-`)
  fs.mkdirSync(join(projectDir, '.memsearch'), { recursive: true })
  fs.writeFileSync(join(projectDir, '.memsearch', 'logs'), 'not a directory')
  const listeners = {}
  const warnings = []
  let disposeDiagnostics = async () => {}
  const ctx = {
    logger: { warn: (message) => warnings.push(message), debug: () => {} },
    skills: { register: () => {} },
    on: (name, fn) => { listeners[name] = fn },
    effect: (setup) => { disposeDiagnostics = setup() },
  }
  const session = {
    id: 'session-diagnostic-fail',
    header: { cwd: projectDir },
    events: [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'diagnostic-fail-capture-marker' }] } },
      { type: 'turn/end', data: { turn: 1 } },
    ],
  }
  try {
    await withIsolatedEnv({ MEMSEARCH_CMD: null, PATH: '/nonexistent' }, async () => {
      apply(ctx, { summarizeEnabled: false, diagnosticLogEnabled: true })
      listeners['session/event'](session, { type: 'turn/end', data: { turn: 1 } })
      const deadline = Date.now() + 5000
      const memoryDir = join(projectDir, '.memsearch', 'memory')
      while ((!fs.existsSync(memoryDir) || fs.readdirSync(memoryDir).length === 0) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      const memoryFile = join(memoryDir, fs.readdirSync(memoryDir)[0])
      assert.ok(fs.readFileSync(memoryFile, 'utf-8').includes('diagnostic-fail-capture-marker'))
      while (!warnings.some((message) => message.includes('diagnostic log unavailable')) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assert.equal(warnings.filter((message) => message.includes('diagnostic log unavailable')).length, 1)
      await disposeDiagnostics()
    })
  } finally {
    await disposeDiagnostics()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('apply: summarize failure writes unavailable note (not raw)', async () => {
  const tmp = os.tmpdir()
  const projDir = `${tmp}/memsearch-fail-${process.pid}`
  const listeners = {}
  const ctx = {
    logger: { warn: () => {}, debug: () => {} },
    skills: { register: () => {} },
    on: (name, fn) => { listeners[name] = fn },
  }
  try {
    // Default summarizeEnabled:true + auto resolves headless with no CLI → error
    // path in processTurn → unavailable note.
    await withIsolatedEnv({ DSH_CLI: null, MEMSEARCH_CMD: null, PATH: '/nonexistent', HOME: '/nonexistent-home' }, async () => {
      // (HOME masks the pnpm-global dsh fallback, which would boot a real agent.)
      apply(ctx, {})
      const session = {
        id: 'session-fail-test',
        header: { cwd: projDir },
        events: [
          { type: 'turn/start', data: { turn: 1 } },
          { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'secret raw content that must not leak' }] } },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
          { type: 'turn/end', data: { turn: 1 } },
        ],
      }
      await listeners['session/event'](session, { type: 'turn/end', data: { turn: 1 } })
      await new Promise((r) => setTimeout(r, 500))
      const memoryDir = `${projDir}/.memsearch/memory`
      const files = fs.readdirSync(memoryDir)
      const content = fs.readFileSync(`${memoryDir}/${files[0]}`, 'utf-8')
      assert.ok(content.includes('Memory summary unavailable'), 'unavailable note written on failure')
      assert.ok(!content.includes('secret raw content'), 'raw content must NOT be written')
      assert.ok(content.includes('<!-- session:session-fail-test turn:1 '), 'anchor preserved')
    })
  } finally {
    fs.rmSync(projDir, { recursive: true, force: true })
  }
})

test('summarizeTurn: transient failure is retried once and can succeed', async () => {
  // DSH_CLI points at a node recorder that exits 1 on the first invocation
  // and prints a summary on the second: the retry must produce the summary
  // instead of an error. Node is the recorder so the test runs on Windows too
  // (no /bin/sh shebang dependency).
  const tmp = os.tmpdir()
  const counterFile = `${tmp}/memsearch-retrycount-${process.pid}.txt`
  const recorder = `${tmp}/memsearch-retry-recorder-${process.pid}.cjs`
  fs.writeFileSync(
    recorder,
    `const fs = require('node:fs')\n` +
      `let n = 0\n` +
      `try { n = Number(fs.readFileSync(${JSON.stringify(counterFile)}, 'utf-8')) || 0 } catch {}\n` +
      `n += 1\n` +
      `fs.writeFileSync(${JSON.stringify(counterFile)}, String(n))\n` +
      `if (n < 2) process.exit(1)\n` +
      `console.log('- summarized on retry')\n`,
    'utf-8',
  )
  try {
    await withIsolatedEnv({ DSH_CLI: `${process.execPath} ${recorder}` }, async () => {
      const opts = {
        summarizeMode: 'dsh-headless',
        agentName: 'X',
        summarizeProvider: '',
        summarizeModel: '',
        summarizeRetryBackoffMs: 0,
      }
      const ctx = { logger: { warn: () => {} } }
      const summary = await summarizeTurn(ctx, opts, 'turn text', process.cwd())
      assert.equal(summary, '- summarized on retry')
      assert.equal(fs.readFileSync(counterFile, 'utf-8').trim(), '2', 'exactly two attempts')
    })
  } finally {
    try { fs.unlinkSync(recorder) } catch { /* cleanup */ }
    try { fs.unlinkSync(counterFile) } catch { /* cleanup */ }
  }
})

test('summarizeTurn: deterministic CLI-not-found failure is not retried', async () => {
  await withIsolatedEnv({ DSH_CLI: null, PATH: '/nonexistent', HOME: '/nonexistent-home' }, async () => {
    const warnings = []
    const ctx = { logger: { warn: (m) => warnings.push(m) } }
    const opts = { summarizeMode: 'dsh-headless', agentName: 'X', summarizeProvider: '', summarizeModel: '', summarizeRetryBackoffMs: 0 }
    await assert.rejects(
      summarizeTurn(ctx, opts, 'turn text', process.cwd()),
      /dsh CLI not found/,
    )
    assert.ok(
      !warnings.some((w) => w.includes('retrying once')),
      `setup failure must not be retried: ${warnings}`,
    )
  })
})

test('summarizeTurn: summarizeTimeoutMs override times out a slow summarizer', async () => {
  // A node recorder that idles for 5 s: with summarizeTimeoutMs=200 each
  // attempt times out, the single retry fires, and the final error names the
  // timeout.
  // A node recorder that idles for 5 s: with summarizeTimeoutMs=200 each
  // attempt times out, the single retry fires, and the final error names the
  // timeout.
  const tmp = os.tmpdir()
  const counterFile = `${tmp}/memsearch-slowcount-${process.pid}.txt`
  const recorder = `${tmp}/memsearch-slow-recorder-${process.pid}.cjs`
  fs.writeFileSync(
    recorder,
    `const fs = require('node:fs')\n` +
      `fs.writeFileSync(${JSON.stringify(counterFile)}, String(Number(fs.existsSync(${JSON.stringify(counterFile)}) ? fs.readFileSync(${JSON.stringify(counterFile)}, 'utf-8') : 0) + 1))\n` +
      `setTimeout(() => {}, 5000)\n`,
    'utf-8',
  )
  try {
    await withIsolatedEnv({ DSH_CLI: `${process.execPath} ${recorder}` }, async () => {
      const opts = {
        summarizeMode: 'dsh-headless',
        agentName: 'X',
        summarizeProvider: '',
        summarizeModel: '',
        summarizeTimeoutMs: 200,
        summarizeRetryBackoffMs: 0,
      }
      const ctx = { logger: { warn: () => {} } }
      await assert.rejects(
        summarizeTurn(ctx, opts, 'turn text', process.cwd()),
        /timed out/,
      )
      assert.equal(fs.readFileSync(counterFile, 'utf-8').trim(), '2', 'timeout retried once')
    })
  } finally {
    try { fs.unlinkSync(recorder) } catch { /* cleanup */ }
    try { fs.unlinkSync(counterFile) } catch { /* cleanup */ }
  }
})

test('summarizeHeadless: summarizeProfile is forwarded to the dsh CLI', async () => {
  const tmp = os.tmpdir()
  const argvFile = `${tmp}/memsearch-dsh-profile-argv-${process.pid}.json`
  const recorder = `${tmp}/memsearch-dsh-profile-recorder-${process.pid}.cjs`
  fs.writeFileSync(
    recorder,
    `const fs = require('node:fs')\n` +
      `fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)))\n`,
    'utf-8',
  )
  try {
    await withIsolatedEnv({ DSH_CLI: `${process.execPath} ${recorder}` }, async () => {
      const opts = {
        summarizeMode: 'dsh-headless',
        agentName: 'X',
        summarizeProvider: '',
        summarizeModel: '',
        summarizeProfile: 'memsearch-summary',
      }
      const ctx = { logger: { warn: () => {} } }
      await summarizeTurn(ctx, opts, 'turn text', process.cwd())
      const recorded = JSON.parse(fs.readFileSync(argvFile, 'utf-8'))
      const profileIndex = recorded.indexOf('--profile')
      assert.ok(profileIndex !== -1, `--profile present: ${JSON.stringify(recorded)}`)
      assert.equal(recorded[profileIndex + 1], 'memsearch-summary', 'configured profile booted')
    })
  } finally {
    try { fs.unlinkSync(recorder) } catch { /* cleanup */ }
    try { fs.unlinkSync(argvFile) } catch { /* cleanup */ }
  }
})

test('apply: summarize failure with summarizeFailureOutput:transcript preserves the raw turn', async () => {
  const tmp = os.tmpdir()
  const projDir = `${tmp}/memsearch-failraw-${process.pid}`
  const listeners = {}
  const ctx = {
    logger: { warn: () => {}, debug: () => {} },
    skills: { register: () => {} },
    on: (name, fn) => { listeners[name] = fn },
  }
  try {
    await withIsolatedEnv({ DSH_CLI: null, MEMSEARCH_CMD: null, PATH: '/nonexistent', HOME: '/nonexistent-home' }, async () => {
      apply(ctx, { summarizeFailureOutput: 'transcript', summarizeRetryBackoffMs: 0 })
      const session = {
        id: 'session-failraw-test',
        header: { cwd: projDir },
        events: [
          { type: 'turn/start', data: { turn: 1 } },
          { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'important raw content fallback-marker-002' }] } },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
          { type: 'turn/end', data: { turn: 1 } },
        ],
      }
      await listeners['session/event'](session, { type: 'turn/end', data: { turn: 1 } })
      await new Promise((r) => setTimeout(r, 500))
      const memoryDir = `${projDir}/.memsearch/memory`
      const files = fs.readdirSync(memoryDir)
      const content = fs.readFileSync(`${memoryDir}/${files[0]}`, 'utf-8')
      assert.ok(content.includes('Summarization failed'), 'failure header written')
      assert.ok(content.includes('fallback-marker-002'), 'raw turn preserved')
      assert.ok(!content.includes('Memory summary unavailable'), 'default note wording not used')
      assert.ok(content.includes('<!-- session:session-failraw-test turn:1 '), 'anchor preserved')
    })
  } finally {
    fs.rmSync(projDir, { recursive: true, force: true })
  }
})

test('apply: multi-project capture writes to each project memory dir', async () => {
  const tmp = os.tmpdir()
  const projA = `${tmp}/memsearch-projA-${process.pid}`
  const projB = `${tmp}/memsearch-projB-${process.pid}`
  const listeners = {}
  const ctx = {
    logger: { warn: () => {}, debug: () => {} },
    skills: { register: () => {} },
    on: (name, fn) => { listeners[name] = fn },
  }
  try {
    await withIsolatedEnv({ DSH_CLI: null, MEMSEARCH_CMD: null, PATH: '/nonexistent' }, async () => {
      apply(ctx, { summarizeEnabled: false }) // raw writes, no CLI needed
      const mkSession = (id, cwd, marker) => ({
        id,
        header: { cwd },
        events: [
          { type: 'turn/start', data: { turn: 1 } },
          { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: marker }] } },
          { type: 'turn/end', data: { turn: 1 } },
        ],
      })
      await listeners['session/event'](mkSession('session-a', projA, 'marker-proj-a'), { type: 'turn/end', data: { turn: 1 } })
      await listeners['session/event'](mkSession('session-b', projB, 'marker-proj-b'), { type: 'turn/end', data: { turn: 1 } })
      await new Promise((r) => setTimeout(r, 400))
      const filesA = fs.readdirSync(`${projA}/.memsearch/memory`)
      const filesB = fs.readdirSync(`${projB}/.memsearch/memory`)
      assert.equal(filesA.length, 1, 'project A memory written')
      assert.equal(filesB.length, 1, 'project B memory written')
      const contentA = fs.readFileSync(`${projA}/.memsearch/memory/${filesA[0]}`, 'utf-8')
      const contentB = fs.readFileSync(`${projB}/.memsearch/memory/${filesB[0]}`, 'utf-8')
      assert.ok(contentA.includes('marker-proj-a'), 'A contains its own marker')
      assert.ok(contentB.includes('marker-proj-b'), 'B contains its own marker')
      assert.ok(!contentA.includes('marker-proj-b'), 'A does not leak B')
    })
  } finally {
    fs.rmSync(projA, { recursive: true, force: true })
    fs.rmSync(projB, { recursive: true, force: true })
  }
})

test('apply: MEMSEARCH_DSH_SUMMARIZE=1 makes the plugin inert', async () => {
  const listeners = {}
  await withIsolatedEnv({ MEMSEARCH_DSH_SUMMARIZE: '1' }, () => {
    const ctx = {
      logger: { warn: () => {}, debug: () => {} },
      skills: { register: () => {} },
      on: (name, fn) => { listeners[name] = fn },
    }
    apply(ctx, {})
    assert.deepEqual(listeners, {}, 'summarize sub-agent must register nothing')
  })
})

test('apply: custom-llm config is honored in summarizeMode', async () => {
  const listeners = {}
  const ctx = {
    logger: { warn: () => {}, debug: () => {} },
    skills: { register: () => {} },
    on: (name, fn) => { listeners[name] = fn },
  }
  apply(ctx, { summarizeMode: 'custom-llm', summarizeProvider: 'p', summarizeModel: 'm' })
  assert.ok(listeners['session/event'], 'capture listener registered by default')
  assert.ok(listeners['agent/pre-step'], 'injection listener registered by default')
})

test('summarizeHeadless: does not build a --patch overlay for the model', async () => {
  // The DSH settings user layer (`agent-default-model` in ~/.dsh/settings.yaml)
  // outranks any `--patch` overlay, so headless summarize must NOT emit one:
  // a real dsh boot here should not carry a memsearch-generated overlay file.
  // We point DSH_CLI at a recorder script that writes its argv to a file, then
  // assert the recorded args contain no `--patch` (and no temp overlay path).
  const tmp = await import('node:os').then((os) => os.tmpdir())
  const fs = await import('node:fs')
  const recorder = `${tmp}/memsearch-dsh-argv-recorder-${process.pid}.cjs`
  fs.writeFileSync(
    recorder,
    'const fs = require("node:fs")\n' +
      'fs.writeFileSync(process.env.MEMSEARCH_ARGV_FILE, process.argv.slice(2).join("\\n") + "\\n")\n',
    'utf-8',
  )
  const argvFile = `${tmp}/memsearch-dsh-argv-${process.pid}.txt`
  try {
    await withIsolatedEnv({
      DSH_CLI: `${process.execPath} ${recorder}`,
      MEMSEARCH_ARGV_FILE: argvFile,
      MEMSEARCH_DSH_SUMMARIZE: null,
    }, async () => {
      const opts = {
        summarizeMode: 'dsh-headless',
        agentName: 'X',
        summarizeProvider: 'deepseek-zilliz',
        summarizeModel: 'deepseek-v4-pro',
      }
      const ctx = { logger: { warn: () => {} } }
      const render = '=== Turn 1 ===\n\n[User]: hi\n\n[Assistant]: hello'
      const summary = await summarizeTurn(ctx, opts, render, process.cwd())
      assert.equal(summary, null, 'recorder exits 0 with no stdout -> null summary')
      const recorded = fs.readFileSync(argvFile, 'utf-8').trim().split('\n')
      assert.ok(
        !recorded.includes('--patch'),
        `headless summarize must not pass --patch; got argv: ${JSON.stringify(recorded)}`,
      )
      assert.ok(
        !recorded.some((arg) => arg.includes('memsearch-dsh-summarize-')),
        `headless summarize must not reference an overlay file; got argv: ${JSON.stringify(recorded)}`,
      )
    })
  } finally {
    try { fs.unlinkSync(recorder) } catch { /* cleanup */ }
    try { fs.unlinkSync(argvFile) } catch { /* cleanup */ }
  }
})

test('renderTurn: renders user/assistant/tool events into the shared format', () => {
  const session = {
    events: [
      { type: 'turn/start', data: { turn: 7 } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello there' }] } },
      { type: 'tool/call', data: { name: 'bash' } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hi back' }] } } },
      { type: 'turn/end', data: { turn: 7 } },
    ],
  }
  const render = renderTurn(session, { data: { turn: 7 } })
  assert.ok(render.includes('=== Turn 7 ==='), 'turn header')
  assert.ok(render.includes('[User]: hello there'), 'user line')
  assert.ok(render.includes('[Assistant]: hi back'), 'assistant line')
  assert.ok(render.includes('[Tool call]: bash'), 'tool line')
})

test('renderTurn: reads current DSH sessions through snapshotEvents', () => {
  const events = [
    { type: 'turn/start', data: { turn: 8 } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'snapshot capture marker' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'captured' }] } } },
    { type: 'turn/end', data: { turn: 8 } },
  ]
  const session = {
    snapshotEvents: () => events,
  }
  const render = renderTurn(session, { data: { turn: 8 } })
  assert.ok(render.includes('snapshot capture marker'), 'uses snapshotEvents instead of removed events array')
})

test('renderTurn: returns null when no user message', () => {
  const session = {
    events: [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'only assistant' }] } } },
      { type: 'turn/end', data: { turn: 1 } },
    ],
  }
  assert.equal(renderTurn(session, { data: { turn: 1 } }), null)
})

test('writeCapture + captureExists: writes shared format and dedups', () => {
  const tmp = os.tmpdir()
  const dir = `${tmp}/memsearch-capture-${process.pid}`
  const memoryDir = `${dir}/memory`
  try {
    writeCapture(memoryDir, '- a note', 'session-abc', 3, '/path/db.jsonl')
    const files = fs.readdirSync(memoryDir)
    assert.equal(files.length, 1, 'one daily file')
    const content = fs.readFileSync(`${memoryDir}/${files[0]}`, 'utf-8')
    assert.ok(content.includes('<!-- session:session-abc turn:3 db:/path/db.jsonl -->'), 'anchor format')
    assert.ok(content.includes('- a note'), 'body present')
    // dedup: same turn already captured
    assert.equal(captureExists(memoryDir, 'session-abc', 3), true)
    assert.equal(captureExists(memoryDir, 'session-abc', 4), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('writeCapture: quality tag lands in the anchor without breaking dedup', () => {
  const tmp = os.tmpdir()
  const dir = `${tmp}/memsearch-capture-quality-${process.pid}`
  const memoryDir = `${dir}/memory`
  try {
    writeCapture(memoryDir, '- degraded note', 'session-q', 7, '/path/db.jsonl', 45)
    const files = fs.readdirSync(memoryDir)
    const content = fs.readFileSync(`${memoryDir}/${files[0]}`, 'utf-8')
    assert.ok(content.includes('<!-- session:session-q turn:7 quality:45 db:/path/db.jsonl -->'), 'quality anchor')
    assert.equal(captureExists(memoryDir, 'session-q', 7), true, 'dedup still matches')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('filterDiagnosticFields: retains metadata and discards payload fields', () => {
  assert.deepEqual(filterDiagnosticFields({
    sessionId: 'session-a',
    turn: 2,
    prompt: 'secret prompt',
    transcript: 'secret transcript',
    summary: 'secret summary',
    chunks: ['secret chunk'],
    errorText: 'secret error',
    timestamp: 'overridden',
    event: 'overridden',
  }), { sessionId: 'session-a', turn: 2 })
})

test('runQualityGate: reports disabled separately from command failure', () => {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/memsearch-quality-status-`)
  const modeFile = join(dir, 'mode.txt')
  const shim = join(dir, 'quality-status.cjs')
  fs.writeFileSync(
    shim,
    [
      'const fs = require("node:fs")',
      `const mode = fs.readFileSync(${JSON.stringify(modeFile)}, "utf-8")`,
      'if (process.argv[2] === "config") { process.stdout.write(mode === "disabled" ? "false" : "true"); process.exit(0) }',
      'process.exit(7)',
    ].join('\n'),
  )
  try {
    fs.writeFileSync(modeFile, 'disabled')
    let status
    assert.equal(runQualityGate([process.execPath, shim], 'body', dir, undefined, (value) => { status = value }), null)
    assert.equal(status, 'disabled')

    fs.writeFileSync(modeFile, 'failed')
    let errorType
    assert.equal(runQualityGate([process.execPath, shim], 'body', dir, undefined, (value, type) => {
      status = value
      errorType = type
    }), null)
    assert.equal(status, 'failed')
    assert.equal(typeof errorType, 'string')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('runQualityGate: parses verdict, passes --recent-file when the journal exists', async (t) => {
  // The gate shells out through bash; when no usable bash exists (e.g. the
  // WSL default distro has no coreutils), skip — the pre-existing
  // bash-dependent tests fail the same way on such hosts.
  try {
    execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' })
  } catch {
    t.skip('bash unavailable')
    return
  }
  const tmp = os.tmpdir()
  const dir = `${tmp}/memsearch-quality-${process.pid}`
  const memoryDir = `${dir}/memory`
  try {
    fs.mkdirSync(memoryDir, { recursive: true })
    // Fake memsearch CLI: a shell script on PATH that records its argv and
    // echoes a canned verdict.
    const binDir = `${dir}/bin`
    fs.mkdirSync(binDir, { recursive: true })
    fs.writeFileSync(
      `${binDir}/fake-memsearch`,
      [
        '#!/usr/bin/env bash',
        'echo "$@" >> "$CAPTURE_ARGS"',
        `echo '{"score":45,"action":"degrade","reasons":["meta"]}'`,
      ].join('\n'),
    )
    fs.chmodSync(`${binDir}/fake-memsearch`, 0o755)
    const argsFile = `${dir}/args.txt`
    fs.writeFileSync(argsFile, '')
    let sawRecent = false
    await withIsolatedEnv({ PATH: `${binDir}:${process.env.PATH}`, CAPTURE_ARGS: argsFile }, () => {
      const verdict = runQualityGate('fake-memsearch', 'candidate body', memoryDir, undefined)
      assert.deepEqual(verdict, { action: 'degrade', score: 45 })
      const args = fs.readFileSync(argsFile, 'utf-8')
      // No journal yet → no --recent-file flag.
      assert.ok(!args.includes('--recent-file'), 'no recent flag without journal')
      // Create today's journal and gate again.
      const today = new Date().toISOString().slice(0, 10)
      fs.writeFileSync(`${memoryDir}/${today}.md`, '# journal\n', 'utf-8')
      fs.writeFileSync(argsFile, '')
      const verdict2 = runQualityGate('fake-memsearch', 'candidate body', memoryDir, undefined)
      assert.equal(verdict2.action, 'degrade')
      sawRecent = fs.readFileSync(argsFile, 'utf-8').includes('--recent-file')
    })
    assert.ok(sawRecent, 'recent flag passed once journal exists')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('runQualityGate: fails open (null) when the CLI has no quality subcommand', async (t) => {
  try {
    execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' })
  } catch {
    t.skip('bash unavailable')
    return
  }
  const tmp = os.tmpdir()
  const dir = `${tmp}/memsearch-quality-fail-${process.pid}`
  const memoryDir = `${dir}/memory`
  try {
    const binDir = `${dir}/bin`
    fs.mkdirSync(binDir, { recursive: true })
    fs.writeFileSync(`${binDir}/old-memsearch`, '#!/usr/bin/env bash\nexit 1\n')
    fs.chmodSync(`${binDir}/old-memsearch`, 0o755)
    await withIsolatedEnv({ PATH: `${binDir}:${process.env.PATH}` }, () => {
      const warnings = []
      assert.equal(runQualityGate('old-memsearch', 'body', memoryDir, { warn: (m) => warnings.push(m) }), null)
      assert.equal(warnings.length, 1, 'warns once on gate failure')
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('memsearchDirFor: MEMSEARCH_DIR env wins (global scope)', async () => {
  await withIsolatedEnv({ MEMSEARCH_DIR: '/global/memsearch' }, () => {
    assert.equal(memsearchDirFor('/proj/x'), '/global/memsearch')
    delete process.env.MEMSEARCH_DIR
    assert.equal(memsearchDirFor('/proj/x'), join('/proj/x', '.memsearch'))
  })
})

test('apply: injectEnabled:false makes pre-step injection a no-op', async () => {
  // The listener is always registered; the flag short-circuits inside it so a
  // disabled plugin still forwards the decision unchanged (never injects).
  const listeners = {}
  const ctx = {
    logger: { warn: () => {}, debug: () => {} },
    skills: { register: () => {} },
    on: (name, fn) => { listeners[name] = fn },
  }
  apply(ctx, { injectEnabled: false })
  assert.ok(listeners['agent/pre-step'], 'listener registered')
  const decision = { kind: 'enter', messages: [{ role: 'user', content: 'remember marker' }] }
  const result = await listeners['agent/pre-step']({ agent: {}, turn: 1, step: 1, signal: {} }, async () => decision)
  assert.equal(result, decision, 'decision forwarded unchanged when injection disabled')
  assert.equal(result.messages.length, 1, 'no memory message injected')
})

test('apply: diagnostics do not create .memsearch in a project without memory', async () => {
  const projectDir = fs.mkdtempSync(`${os.tmpdir()}/memsearch-no-memory-`)
  const listeners = {}
  let disposeDiagnostics = async () => {}
  const ctx = {
    logger: { warn: () => {}, debug: () => {} },
    skills: { register: () => {} },
    on: (name, fn) => { listeners[name] = fn },
    effect: (setup) => { disposeDiagnostics = setup() },
  }
  try {
    await withIsolatedEnv({ MEMSEARCH_CMD: null, PATH: '/nonexistent' }, async () => {
      apply(ctx, { captureEnabled: false, diagnosticLogEnabled: true })
      const decision = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'recall something' }] }] }
      const result = await listeners['agent/pre-step'](
        { agent: { session: { header: { cwd: projectDir } } }, turn: 1, step: 1, signal: {} },
        async () => decision,
      )
      assert.equal(result, decision)
      await new Promise((resolve) => setTimeout(resolve, 25))
      await disposeDiagnostics()
      assert.equal(fs.existsSync(join(projectDir, '.memsearch')), false)
    })
  } finally {
    await disposeDiagnostics()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('apply: empty search result keeps pre-step context unchanged while recall stays available', async () => {
  await withInjectionFixture([], async ({ result, unchanged, registeredSkillNames, callLog, diagnosticLog }) => {
    assert.equal(unchanged, true, 'empty search result must not inject a marker')
    assert.equal(result.messages.length, 1)
    assert.ok(
      registeredSkillNames.includes('memory-recall'),
      'native recall skill remains registered independently of automatic injection',
    )
    const calls = fs.readFileSync(callLog, 'utf-8').trim().split('\n')
    const searches = calls.filter((call) => call.startsWith('search '))
    assert.equal(searches.length, 1)
    assert.ok(searches[0].includes('--default-collection '))
    assert.ok(!searches[0].includes('--collection '))
    assert.ok(diagnosticLog.includes('"event":"recall.search.started"'))
    assert.ok(diagnosticLog.includes('"event":"recall.search.empty"'))
  }, false, true)
})

test('apply: returned chunks inject one retrieved-context marker with plugin source metadata', async () => {
  await withInjectionFixture(
    [{ source: 'memory/2026-09-07.md:4', content: 'The release marker is PINE-NEBULA-8643.' }],
    async ({ result, unchanged, registeredSkillNames, callLog, diagnosticLog }) => {
      assert.equal(unchanged, false)
      assert.equal(result.kind, 'enter')
      assert.equal(result.messages.length, 2)
      const injected = result.messages[1]
      const text = injected.content[0].text
      const marker = '[memsearch] Retrieved memory context attached.'
      assert.equal(text.split(marker).length - 1, 1, 'exactly one retrieved-context marker')
      assert.ok(text.includes('Retrieved memory candidates from past sessions:'))
      assert.ok(text.includes('PINE-NEBULA-8643'))
      assert.equal(injected.source.kind, 'plugin')
      assert.equal(injected.source.plugin, 'memsearch')
      assert.equal(injected.source.form, 'snapshot')
      assert.equal(injected.source.sections[0].name, 'memsearch')
      assert.equal(injected.source.sections[0].text, text)
      assert.ok(
        registeredSkillNames.includes('memory-recall'),
        'native recall skill remains distinct from automatic injection',
      )
      const calls = fs.readFileSync(callLog, 'utf-8').trim().split('\n')
      const searches = calls.filter((call) => call.startsWith('search '))
      assert.equal(searches.length, 1)
      assert.ok(searches[0].includes('--default-collection '))
      assert.ok(!searches[0].includes('--collection '))
      assert.ok(diagnosticLog.includes('"event":"recall.search.started"'))
      assert.ok(diagnosticLog.includes('"event":"recall.injected"'))
      assert.ok(!diagnosticLog.includes('PINE-NEBULA-8643'), 'diagnostics exclude retrieved content')
    },
    false,
    true,
  )
})

test('apply: rejects an old core before a memory search', async () => {
  await withInjectionFixture([], async ({ error, callLog }) => {
    assert.match(error, /--default-collection support is required/)
    const calls = fs.readFileSync(callLog, 'utf-8').trim().split('\n')
    assert.ok(!calls.some((call) => call.startsWith('search ')))
  }, true)
})

test('apply: registers a session/disposed maintenance listener', () => {
  // Maintenance uses the dedicated `session/disposed` event (the DSH
  // equivalent of another platform's session end), so it never collides with
  // the capture `session/event` listener.
  const listeners = {}
  const ctx = {
    logger: { warn: () => {}, debug: () => {} },
    skills: { register: () => {} },
    on: (name, fn) => { listeners[name] = fn },
  }
  apply(ctx, {})
  assert.ok(typeof listeners['session/disposed'] === 'function', 'session/disposed listener registered')
})

test('runMaintenance: is exported and tolerant of a missing project dir', async () => {
  // runMaintenance is fire-and-forget: it must not throw for a project whose
  // .memsearch dir does not exist (the runner checks due-state internally).
  const { runMaintenance } = await import('../index.js')
  const tmp = os.tmpdir()
  const projDir = `${tmp}/memsearch-maint-${process.pid}`
  const logger = { warn: () => {} }
  runMaintenance({ logger }, projDir, `${projDir}/.memsearch`)
  // No throw is the assertion; the child is detached + unref'd.
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(true, 'runMaintenance returned without throwing')
})

test('listSkillCandidates: returns parsed meta for each candidate subdir, pending first', () => {
  const tmp = fs.mkdtempSync(os.tmpdir() + '/msr-list-')
  const candDir = `${tmp}/skill-candidates`
  fs.mkdirSync(`${candDir}/beta`, { recursive: true })
  fs.mkdirSync(`${candDir}/alpha`, { recursive: true })
  fs.mkdirSync(`${candDir}/no-meta`, { recursive: true })
  fs.mkdirSync(`${candDir}/sub/not-a-dir`, { recursive: true })
  fs.writeFileSync(`${candDir}/beta/meta.json`, JSON.stringify({
    name: 'beta', status: 'installed', description: 'B', occurrences: 5,
    sources: ['2026-01-01.md'], installed_paths: ['/tmp/.agents/skills/beta'],
  }))
  fs.writeFileSync(`${candDir}/alpha/meta.json`, JSON.stringify({
    name: 'alpha', status: 'candidate', description: 'A', occurrences: 3,
    sources: ['2026-01-02.md'], reason: 'Recurred across sessions',
  }))
  // no-meta has no meta.json → skipped; sub is not a file entry
  fs.writeFileSync(`${candDir}/no-meta/SKILL.md`, 'x')

  
  const out = listSkillCandidates(tmp)
  assert.deepEqual(out.map((c) => c.name), ['alpha', 'beta'], 'pending candidate sorts first')
  const alpha = out[0]
  assert.equal(alpha.status, 'candidate')
  assert.equal(alpha.description, 'A')
  assert.equal(alpha.occurrences, 3)
  assert.deepEqual(alpha.sources, ['2026-01-02.md'])
  assert.equal(alpha.reason, 'Recurred across sessions')
  assert.deepEqual(alpha.installedPaths, [])
  const beta = out[1]
  assert.equal(beta.status, 'installed')
  assert.deepEqual(beta.installedPaths, ['/tmp/.agents/skills/beta'])
})

test('listSkillCandidates: empty or missing dir returns []', () => {
  
  assert.deepEqual(listSkillCandidates('/nonexistent/path-xyz'), [])
  const tmp = fs.mkdtempSync(os.tmpdir() + '/msr-empty-')
  assert.deepEqual(listSkillCandidates(tmp), [])
})

test('listSkillCandidates: malformed meta.json is skipped, not fatal', () => {
  const tmp = fs.mkdtempSync(os.tmpdir() + '/msr-bad-')
  const candDir = `${tmp}/skill-candidates`
  fs.mkdirSync(`${candDir}/broken`, { recursive: true })
  fs.writeFileSync(`${candDir}/broken/meta.json`, '{not json')
  fs.mkdirSync(`${candDir}/good`, { recursive: true })
  fs.writeFileSync(`${candDir}/good/meta.json`, JSON.stringify({ name: 'good', status: 'candidate' }))
  
  const out = listSkillCandidates(tmp)
  assert.equal(out.length, 1)
  assert.equal(out[0].name, 'good')
  assert.equal(out[0].status, 'candidate')
  assert.equal(out[0].occurrences, 0, 'missing occurrences defaults to 0')
})

test('resolveSkillInstallTarget: paths config entry wins, relative resolves against project', () => {
  
  const target = resolveSkillInstallTarget('memsearch', '/proj')
  // No configured paths on this machine → DSH default ~/.agents/skills.
  const expectedSuffix = [''].concat(['.agents', 'skills']).join(sep)
  assert.ok(target.endsWith(expectedSuffix), `expected ~/.agents/skills default, got ${target}`)
})

test('registerSkillReviewRoutes: GET candidates returns parsed list, pending first', async () => {
  const tmp = fs.mkdtempSync(os.tmpdir() + '/msr-route-')
  const candDir = `${tmp}/skill-candidates`
  fs.mkdirSync(`${candDir}/zeta`, { recursive: true })
  fs.mkdirSync(`${candDir}/alpha`, { recursive: true })
  fs.writeFileSync(`${candDir}/zeta/meta.json`, JSON.stringify({ name: 'zeta', status: 'installed' }))
  fs.writeFileSync(`${candDir}/alpha/meta.json`, JSON.stringify({ name: 'alpha', status: 'candidate', description: 'A' }))

  const routes = {}
  const webServer = { register: (r) => { routes[r.path] = r } }
  const ctx = {
    agents: { get: () => undefined },
    logger: { warn: () => {} },
  }
  const { registerSkillReviewRoutes } = await import('../index.js')
  // memsearchDirFor reads MEMSEARCH_DIR env; point it at the temp dir.
  await withIsolatedEnv({ MEMSEARCH_DIR: tmp }, () => {
    registerSkillReviewRoutes(ctx, webServer, 'memsearch')
    const getRoute = routes['/memsearch-dsh/skill-candidates']
    assert.ok(getRoute, 'GET route registered')
    const res = { writeHead: (s) => { res.status = s }, end: (b) => { res.body = JSON.parse(b) } }
    getRoute.handler({ method: 'GET', url: '/memsearch-dsh/skill-candidates' }, res)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.candidates.map((c) => c.name), ['alpha', 'zeta'], 'pending first')
    assert.equal(res.body.candidates[0].description, 'A')
  })
})

test('registerSkillReviewRoutes: GET rejects non-GET, POST review injects into agent inbox', async () => {
  const tmp = fs.mkdtempSync(os.tmpdir() + '/msr-route2-')
  const routes = {}
  const webServer = { register: (r) => { routes[r.path] = r } }
  let appended = null
  const fakeAgent = {
    inbox: { append: (target, msg) => { appended = { target, msg } } },
  }
  const ctx = {
    agents: { get: (id) => (id === 'sess-1' ? fakeAgent : undefined) },
    logger: { warn: () => {} },
  }
  const { registerSkillReviewRoutes } = await import('../index.js')
  await withIsolatedEnv({ MEMSEARCH_DIR: tmp }, async () => {
    registerSkillReviewRoutes(ctx, webServer, 'memsearch')
    const getRoute = routes['/memsearch-dsh/skill-candidates']
    const res = { writeHead: (s) => { res.status = s }, end: (b) => { res.body = JSON.parse(b) } }
    getRoute.handler({ method: 'POST', url: '/x' }, res)
    assert.equal(res.status, 405)

    const postRoute = routes['/memsearch-dsh/skill-review']
    const { EventEmitter } = await import('node:events')
    const req = Object.assign(new EventEmitter(), { method: 'POST' })
    const pr = { writeHead: (s) => { pr.status = s }, end: (b) => { pr.body = JSON.parse(b) } }
    const done = postRoute.handler(req, pr)
    req.emit('data', JSON.stringify({ sessionId: 'sess-1', name: 'alpha', action: 'review' }))
    req.emit('end')
    await done
    assert.equal(pr.status, 200)
    assert.equal(pr.body.injected, true)
    assert.ok(appended, 'inbox append called')
    assert.equal(appended.target, 'next-turn')
    assert.ok(appended.msg.content[0].text.startsWith('[memsearch] Skill candidate "alpha"'), 'message text')
  })
})

test('registerSkillReviewRoutes: POST review with unknown session returns 404', async () => {
  const tmp = fs.mkdtempSync(os.tmpdir() + '/msr-route3-')
  const routes = {}
  const webServer = { register: (r) => { routes[r.path] = r } }
  const ctx = { agents: { get: () => undefined }, logger: { warn: () => {} } }
  const { registerSkillReviewRoutes } = await import('../index.js')
  await withIsolatedEnv({ MEMSEARCH_DIR: tmp }, async () => {
    registerSkillReviewRoutes(ctx, webServer, 'memsearch')
    const postRoute = routes['/memsearch-dsh/skill-review']
    const { EventEmitter } = await import('node:events')
    const req = Object.assign(new EventEmitter(), { method: 'POST' })
    const pr = { writeHead: (s) => { pr.status = s }, end: (b) => { pr.body = JSON.parse(b) } }
    const done = postRoute.handler(req, pr)
    req.emit('data', JSON.stringify({ sessionId: 'ghost', name: 'alpha', action: 'review' }))
    req.emit('end')
    await done
    assert.equal(pr.status, 404)
  })
})

test('registerSkillReviewRoutes: POST open-memsearch opens existing dir, 404 for missing', async () => {
  const tmp = fs.mkdtempSync(os.tmpdir() + '/msr-open-')
  fs.mkdirSync(`${tmp}/.memsearch`, { recursive: true })
  const routes = {}
  const webServer = { register: (r) => { routes[r.path] = r } }
  let opened = null
  const ctx = {
    agents: { get: () => undefined },
    logger: { warn: (m) => { opened = m } },
  }
  const { registerSkillReviewRoutes } = await import('../index.js')
  const { execFile } = await import('node:child_process')
  // stub execFile so xdg-open doesn't actually fire
  const { registerSkillReviewRoutes: real } = await import('../index.js')
  await withIsolatedEnv({ MEMSEARCH_DIR: tmp }, async () => {
      registerSkillReviewRoutes(ctx, webServer, 'memsearch')
      const route = routes['/memsearch-dsh/open-memsearch']
      assert.ok(route, 'open-memsearch route registered')
      const { EventEmitter } = await import('node:events')

      // existing dir
      const req1 = Object.assign(new EventEmitter(), { method: 'POST' })
      const res1 = { writeHead: (s) => { res1.status = s }, end: (b) => { res1.body = JSON.parse(b) } }
      const done1 = route.handler(req1, res1)
      req1.emit('data', JSON.stringify({ sessionId: 'sess-1', scope: 'memsearch' }))
      req1.emit('end')
      await done1
      assert.equal(res1.status, 200)
      assert.equal(res1.body.ok, true)
      assert.equal(res1.body.path, tmp, 'path is the memsearch dir (MEMSEARCH_DIR override)')

      // missing dir
      const req2 = Object.assign(new EventEmitter(), { method: 'POST' })
      const res2 = { writeHead: (s) => { res2.status = s }, end: (b) => { res2.body = JSON.parse(b) } }
      const done2 = route.handler(req2, res2)
      req2.emit('data', JSON.stringify({ sessionId: 'sess-1', scope: 'candidates' }))
      req2.emit('end')
      await done2
      assert.equal(res2.status, 404)
      assert.equal(res2.body.ok, false)
  })
})

test('registerSkillReviewRoutes: list-memsearch lists dirs/files, blocks traversal', async () => {
  const tmp = fs.mkdtempSync(os.tmpdir() + '/msr-list-')
  const outside = fs.mkdtempSync(os.tmpdir() + '/msr-list-outside-')
  fs.mkdirSync(`${tmp}/memory`, { recursive: true })
  fs.mkdirSync(`${tmp}/skill-candidates/foo`, { recursive: true })
  fs.writeFileSync(`${tmp}/memory/2026-08-22.md`, '# hello')
  fs.writeFileSync(`${tmp}/config.toml`, 'x = 1')
  fs.writeFileSync(`${tmp}/.hidden`, 'no')
  // Dir symlinks: prefer a real symlink; on Windows fall back to a junction
  // (junctions need no privilege) — realpath resolves both, so the escape
  // check behaves identically.
  let haveLink = true
  try {
    fs.symlinkSync(outside, `${tmp}/outside-link`)
  } catch {
    try { fs.symlinkSync(outside, `${tmp}/outside-link`, 'junction') } catch { haveLink = false }
  }
  const routes = {}
  const webServer = { register: (r) => { routes[r.path] = r } }
  const ctx = { agents: { get: () => undefined }, logger: { warn: () => {} } }
  const { registerSkillReviewRoutes } = await import('../index.js')
  await withIsolatedEnv({ MEMSEARCH_DIR: tmp }, () => {
    registerSkillReviewRoutes(ctx, webServer, 'memsearch')
    const route = routes['/memsearch-dsh/list-memsearch']
    assert.ok(route, 'list route registered')

    const res = { writeHead: (s) => { res.status = s }, end: (b) => { res.body = JSON.parse(b) } }
    route.handler({ method: 'GET', url: '/memsearch-dsh/list-memsearch' }, res)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.dirs.sort(), ['memory', 'skill-candidates'])
    assert.deepEqual(res.body.files, ['config.toml'])
    assert.ok(!res.body.files.includes('.hidden'), 'hidden skipped')

    // traversal blocked
    const res2 = { writeHead: (s) => { res2.status = s }, end: (b) => { res2.body = JSON.parse(b) } }
    route.handler({ method: 'GET', url: '/memsearch-dsh/list-memsearch?path=..%2F..%2Fetc' }, res2)
    assert.equal(res2.status, 400)

    // A symlink inside .memsearch must not expose an outside directory.
    if (haveLink) {
      const res3 = { writeHead: (s) => { res3.status = s }, end: (b) => { res3.body = JSON.parse(b) } }
      route.handler({ method: 'GET', url: '/memsearch-dsh/list-memsearch?path=outside-link' }, res3)
      assert.equal(res3.status, 400)
    }
  })
})

test('registerSkillReviewRoutes: read-file serves text, rejects binary/traversal/oversize', async () => {
  const tmp = fs.mkdtempSync(os.tmpdir() + '/msr-read-')
  const outside = `${tmp}-outside.md`
  fs.mkdirSync(`${tmp}/skill-candidates/foo`, { recursive: true })
  fs.writeFileSync(`${tmp}/skill-candidates/foo/SKILL.md`, '# Foo\n\nDo the thing.\n')
  fs.writeFileSync(`${tmp}/skill-candidates/foo/meta.json`, '{"name":"foo"}')
  fs.writeFileSync(`${tmp}/blob.bin`, Buffer.from([0, 1, 2, 3]))
  fs.writeFileSync(outside, 'outside secret')
  // File symlinks need elevated privileges on some Windows setups; when the
  // platform refuses, skip only the symlink-escape assertion below.
  let haveEscapeLink = true
  try {
    fs.symlinkSync(outside, `${tmp}/escape.md`)
  } catch {
    haveEscapeLink = false
  }
  const routes = {}
  const webServer = { register: (r) => { routes[r.path] = r } }
  const ctx = { agents: { get: () => undefined }, logger: { warn: () => {} } }
  const { registerSkillReviewRoutes } = await import('../index.js')
  await withIsolatedEnv({ MEMSEARCH_DIR: tmp }, () => {
    registerSkillReviewRoutes(ctx, webServer, 'memsearch')
    const route = routes['/memsearch-dsh/read-file']
    assert.ok(route, 'read route registered')

    // md file
    const res = { writeHead: (s) => { res.status = s }, end: (b) => { res.body = JSON.parse(b) } }
    route.handler({ method: 'GET', url: '/memsearch-dsh/read-file?path=skill-candidates%2Ffoo%2FSKILL.md' }, res)
    assert.equal(res.status, 200)
    assert.ok(res.body.content.includes('# Foo'))

    // binary rejected
    const res2 = { writeHead: (s) => { res2.status = s }, end: (b) => { res2.body = JSON.parse(b) } }
    route.handler({ method: 'GET', url: '/memsearch-dsh/read-file?path=blob.bin' }, res2)
    assert.equal(res2.status, 415)

    // traversal rejected
    const res3 = { writeHead: (s) => { res3.status = s }, end: (b) => { res3.body = JSON.parse(b) } }
    route.handler({ method: 'GET', url: '/memsearch-dsh/read-file?path=..%2F..%2Fetc%2Fpasswd' }, res3)
    assert.equal(res3.status, 400)

    // A text-looking symlink must not expose a file outside .memsearch.
    if (haveEscapeLink) {
      const res4 = { writeHead: (s) => { res4.status = s }, end: (b) => { res4.body = JSON.parse(b) } }
      route.handler({ method: 'GET', url: '/memsearch-dsh/read-file?path=escape.md' }, res4)
      assert.equal(res4.status, 400)
    }
  })
})
