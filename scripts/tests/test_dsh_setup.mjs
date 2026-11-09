import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { planSetup, applySetup, restoreSetup, main } from '../dsh-setup.mjs';

function fixture(t, original = '# user settings\r\n- id: another-plugin\r\n  config:\r\n    value: !!js "process.env.EXAMPLE"\r\n') {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'dsh setup 用户 #50% ')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source checkout');
  const home = path.join(root, 'dsh home');
  const profile = path.join(home, 'profiles', 'desktop');
  const skill = path.join(source, '.agents', 'skills', 'easyeda-agent');
  const server = path.join(source, 'mcp', 'src');
  const sdk = path.join(source, 'node_modules', '@modelcontextprotocol', 'sdk', 'server');
  for (const directory of [profile, skill, server, sdk]) mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: easyeda-agent\n---\n');
  writeFileSync(path.join(server, 'server.mjs'), '// fixture, not a live MCP server\n');
  writeFileSync(path.join(sdk, 'index.js'), '// resolution fixture, not a handshake\n');
  const target = path.join(profile, 'cordis.patch.yml');
  writeFileSync(target, original);
  const options = { home, source, agentsHome: path.join(root, 'agents home'), profile: 'desktop', cli: process.execPath };
  return { root, source, home, profile, target, options };
}

test('preview preserves exact config bytes, does not create backups, quotes paths and does not register a duplicate Skill', (t) => {
  const f = fixture(t);
  const before = readFileSync(f.target);
  const plan = planSetup(f.options);
  assert.equal(plan.changed, true);
  assert.deepEqual(readFileSync(f.target), before);
  assert.equal(existsSync(path.join(f.profile, '.easyeda-agent')), false);
  assert.ok(plan.after.subarray(0, before.length).equals(before));
  assert.match(plan.block, /command: "/);
  assert.ok(plan.block.includes(JSON.stringify(path.join(f.source, 'mcp', 'src', 'server.mjs'))));
  assert.equal(plan.skill.matchesCheckout, false);
  assert.doesNotMatch(plan.block, /easyeda-skill-fs|customSkillDirs|PATH:/);
});

test('apply is byte-idempotent; receipt restores the exact original including BOM and CRLF', (t) => {
  const f = fixture(t, '\uFEFF# comment\r\n[]\r\n');
  const before = readFileSync(f.target);
  const first = applySetup(planSetup(f.options));
  assert.equal(first.status, 'configured-not-runtime-verified');
  const configured = readFileSync(f.target);
  assert.equal(applySetup(planSetup(f.options)).status, 'unchanged');
  assert.deepEqual(readFileSync(f.target), configured);
  assert.equal(restoreSetup(first.receipt).status, 'restored-not-runtime-verified');
  assert.deepEqual(readFileSync(f.target), before);
  assert.equal(restoreSetup(first.receipt).status, 'already-restored');
});

test('applying a changed binary path modifies only the owned marker block', (t) => {
  const f = fixture(t);
  applySetup(planSetup(f.options));
  const after = readFileSync(f.target, 'utf8') + '\r\n- id: user-added-after\r\n';
  writeFileSync(f.target, after);
  const binary = path.join(f.root, 'other cli.exe');
  writeFileSync(binary, 'file identity fixture');
  const next = planSetup({ ...f.options, cli: binary });
  assert.ok(next.after.toString('utf8').endsWith('\r\n- id: user-added-after\r\n'));
  assert.equal((next.after.toString('utf8').match(/id: easyeda-mcp/g) || []).length, 1);
  assert.equal(applySetup(next).status, 'configured-not-runtime-verified');
});

test('existing unowned id or server and installed bundle are preserved', async (t) => {
  for (const original of ['- insert:\n    - id: easyeda-mcp\n', '- id: custom\n  config:\n    serverName: easyeda\n',
    '- insert:\n    - id: easyeda-skill-fs\n', '- {"id": "easyeda-mcp"}\n']) {
    await t.test(original.split('\n')[0], (s) => {
      const f = fixture(s, original);
      assert.throws(() => planSetup(f.options), /Unmanaged EasyEDA/);
      assert.equal(readFileSync(f.target, 'utf8'), original);
    });
  }
  const f = fixture(t);
  writeFileSync(path.join(f.profile, 'package.json'), JSON.stringify({ dependencies: { 'easyeda-agent-dsh': 'file:example' } }));
  assert.throws(() => planSetup(f.options), /bundle already installed/);
});

test('malformed or duplicate markers, invalid root, invalid UTF-8 and profile traversal fail without writes', (t) => {
  for (const original of ['# BEGIN easyeda-agent source MCP (scripts/dsh-setup.mjs)\n',
    'config:\n  a: 1\n', Buffer.from([0xff])]) {
    const f = fixture(t, original);
    const before = readFileSync(f.target);
    assert.throws(() => planSetup(f.options));
    assert.deepEqual(readFileSync(f.target), before);
  }
  const f = fixture(t);
  assert.throws(() => planSetup({ ...f.options, profile: '../desktop' }), /profile name/);
  const plan = planSetup(f.options);
  writeFileSync(f.target, plan.after.toString() + plan.block);
  assert.throws(() => planSetup(f.options), /duplicate managed markers/);
});

test('stale preview, later user edits and corrupted backups prevent destructive rollback', (t) => {
  const f = fixture(t);
  const stale = planSetup(f.options);
  writeFileSync(f.target, '# new settings\n[]\n');
  assert.throws(() => applySetup(stale), /changed since preview/);
  const receipt = applySetup(planSetup(f.options)).receipt;
  const configured = readFileSync(f.target);
  writeFileSync(f.target, configured.toString() + '# user edit\n');
  assert.throws(() => restoreSetup(receipt), /newer changes/);
  writeFileSync(f.target, configured);
  writeFileSync(path.join(path.dirname(receipt), 'cordis.patch.yml'), 'broken');
  assert.throws(() => restoreSetup(receipt), /integrity check failed/);
  assert.deepEqual(readFileSync(f.target), configured);
  assert.throws(() => restoreSetup(f.target), /receipt returned/);
});

test('CLI rejects unknown flags and relative executable paths before changing configuration', () => {
  assert.throws(() => main(['--unknown']), /Unknown option/);
  assert.throws(() => main(['--easyeda-bin', 'easyeda']), /absolute path/);
  assert.throws(() => main(['--restore']), /Missing receipt/);
});

test('preflight discloses a shared user Skill shadow without deleting or registering it', (t) => {
  const f = fixture(t);
  const oldSkill = path.join(f.options.agentsHome, 'skills', 'easyeda-agent');
  mkdirSync(oldSkill, { recursive: true });
  writeFileSync(path.join(oldSkill, 'SKILL.md'), 'old skill, preserved');
  const plan = planSetup(f.options);
  assert.equal(plan.skill.candidates.length, 1);
  assert.equal(plan.skill.candidates[0].matchesCheckout, false);
  assert.equal(plan.skill.candidates[0].resolved, realpathSync(oldSkill));
  assert.ok(plan.warnings.some((warning) => warning.includes('old rules')));
  assert.equal(readFileSync(path.join(oldSkill, 'SKILL.md'), 'utf8'), 'old skill, preserved');
});

test('trailing marker spaces are recognized without adding a second MCP block', (t) => {
  const f = fixture(t);
  const plan = planSetup(f.options);
  writeFileSync(f.target, plan.after.toString().replace('# BEGIN easyeda-agent source MCP (scripts/dsh-setup.mjs)',
    '# BEGIN easyeda-agent source MCP (scripts/dsh-setup.mjs) ').replace('# END easyeda-agent source MCP (scripts/dsh-setup.mjs)',
    '# END easyeda-agent source MCP (scripts/dsh-setup.mjs)\t'));
  applySetup(planSetup(f.options));
  assert.equal(planSetup(f.options).changed, false);
  assert.equal((readFileSync(f.target, 'utf8').match(/id: easyeda-mcp/g) || []).length, 1);
});
