#!/usr/bin/env node
// Source-checkout fallback. Prefer the existing DSH bundle for distributed installs.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync,
  writeFileSync, unlinkSync,
} from 'node:fs';

const BEGIN = '# BEGIN easyeda-agent source MCP (scripts/dsh-setup.mjs)';
const END = '# END easyeda-agent source MCP (scripts/dsh-setup.mjs)';
const checkout = fileURLToPath(new URL('../', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => JSON.stringify(value);

function regularFile(filename) {
  const resolved = realpathSync(filename);
  if (!statSync(resolved).isFile()) throw new Error(`Not a regular file: ${filename}`);
  return resolved;
}

export function planSetup(options) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(options.profile || '')) {
    throw new Error('Use an explicit profile name, without path separators.');
  }
  const source = realpathSync(options.source || checkout);
  const home = realpathSync(options.home);
  const profile = realpathSync(path.join(home, 'profiles', options.profile));
  const target = regularFile(path.join(profile, 'cordis.patch.yml'));
  if (target !== path.join(profile, 'cordis.patch.yml')) throw new Error('Linked patch files are not managed.');
  const server = regularFile(path.join(source, 'mcp', 'src', 'server.mjs'));
  const cli = regularFile(options.cli);
  const node = regularFile(options.node || process.execPath);
  regularFile(path.join(source, '.agents', 'skills', 'easyeda-agent', 'SKILL.md'));
  // Resolve where the actual server will load its SDK; no network or install scripts.
  createRequire(server).resolve('@modelcontextprotocol/sdk/server/index.js');

  const before = readFileSync(target);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(before);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const begins = [...text.matchAll(/^# BEGIN easyeda-agent source MCP \(scripts\/dsh-setup\.mjs\)[ \t]*\r?$/gm)];
  const ends = [...text.matchAll(/^# END easyeda-agent source MCP \(scripts\/dsh-setup\.mjs\)[ \t]*\r?$/gm)];
  if (begins.length !== ends.length || begins.length > 1 || (begins.length && begins[0].index >= ends[0].index)) {
    throw new Error('Malformed or duplicate managed markers; no files changed.');
  }
  let outside = text;
  let start;
  let finish;
  if (begins.length) {
    start = begins[0].index;
    finish = ends[0].index + END.length;
    outside = text.slice(0, start) + text.slice(finish);
  }
  const packageFile = path.join(profile, 'package.json');
  const manifest = existsSync(packageFile) ? JSON.parse(readFileSync(packageFile, 'utf8')) : {};
  const bundles = manifest.dsh?.profile?.bundles || [];
  if (!Array.isArray(bundles)) throw new Error('Unrecognized profile bundle declaration.');
  if (Object.keys(manifest.dependencies || {}).includes('easyeda-agent-dsh') ||
      bundles.some((value) => typeof value === 'string' && /easyeda-agent/.test(value))) {
    throw new Error('DSH bundle already installed. Use that route; do not also inject a source MCP.');
  }
  const config = outside + '\n' + (existsSync(path.join(profile, 'cordis.yml'))
    ? readFileSync(path.join(profile, 'cordis.yml'), 'utf8') : '');
  if (/(?:["']?id["']?\s*:\s*["']?easyeda-(?:mcp|skill-fs)\b|["']?serverName["']?\s*:\s*["']?easyeda\b)/.test(config)) {
    throw new Error('Unmanaged EasyEDA entry exists. Preserve it; inspect the composed DSH config first.');
  }
  const first = outside.replace(/^\uFEFF/, '').split(/\r?\n/).find((line) => line.trim() && !line.trimStart().startsWith('#'));
  if (first && !/^(?:-\s|\[\]\s*(?:#.*)?$)/.test(first)) {
    throw new Error('Expected a YAML patch-list root; no files changed.');
  }
  const block = [BEGIN, '- insert:', '    - id: easyeda-mcp', "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:', '        serverName: easyeda', '        transport: stdio',
    `        command: ${json(node)}`, '        args:', `          - ${json(server)}`,
    '        env:', `          EASYEDA_BIN: ${json(cli)}`, '        failOnStartupError: false', END].join(newline);
  let result;
  if (begins.length) result = text.slice(0, start) + block + text.slice(finish);
  else {
    // Only expand a standalone empty-list root; never rewrite other YAML or !!js expressions.
    const prefix = text.replace(/^(\uFEFF)?\[\]([ \t]*(?:#.*)?)\r?$/m, '$1$2');
    result = prefix + (prefix && !prefix.endsWith('\n') ? newline : '') + block + newline;
  }
  const skill = path.join(home, 'skills', 'easyeda-agent');
  const canonical = realpathSync(path.join(source, '.agents', 'skills', 'easyeda-agent'));
  const roots = [skill, path.join(options.agentsHome || process.env.AGENTS_HOME || path.join(homedir(), '.agents'), 'skills', 'easyeda-agent')];
  const candidates = [...new Set(roots)].filter((p) => lstatSync(p, { throwIfNoEntry: false })).map((p) => {
    try {
      const resolved = realpathSync(p);
      const readable = existsSync(path.join(resolved, 'SKILL.md')) && statSync(path.join(resolved, 'SKILL.md')).isFile();
      return { path: p, resolved, readable, matchesCheckout: readable && resolved === canonical };
    } catch (error) { return { path: p, readable: false, matchesCheckout: false, error: error.code || 'unreadable' }; }
  });
  const skillMatches = candidates.some((candidate) => candidate.path === skill && candidate.matchesCheckout);
  const warnings = [];
  if (!skillMatches) warnings.push('The DSH user Skill does not resolve to this checkout; MCP configuration alone does not install its Skill.');
  if (candidates.some((candidate) => !candidate.matchesCheckout)) warnings.push('Other or unreadable user Skill copies exist; link changes may select old rules. No copies were removed.');
  return { target, before, after: Buffer.from(result, 'utf8'), block, cli, node, source,
    skill: { path: skill, matchesCheckout: skillMatches, candidates }, warnings,
    changed: !before.equals(Buffer.from(result, 'utf8')) };
}

export function applySetup(plan) {
  if (!readFileSync(plan.target).equals(plan.before)) throw new Error('Profile changed since preview; rerun preflight.');
  if (!plan.changed) return { status: 'unchanged', target: plan.target };
  const backupDir = path.join(path.dirname(plan.target), '.easyeda-agent', 'backups', randomUUID());
  mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, 'cordis.patch.yml');
  const receipt = path.join(backupDir, 'receipt.json');
  writeFileSync(backup, plan.before, { flag: 'wx', mode: 0o600 });
  writeFileSync(receipt, json({ schemaVersion: 1, beforeSHA256: hash(plan.before), afterSHA256: hash(plan.after) }) + '\n',
    { flag: 'wx', mode: 0o600 });
  atomicReplace(plan.target, plan.after, plan.before);
  return { status: 'configured-not-runtime-verified', target: plan.target, receipt };
}

function atomicReplace(target, bytes, expected) {
  const temporary = target + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: statSync(target).mode });
    if (!readFileSync(target).equals(expected)) throw new Error('Profile changed while writing; original preserved.');
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function restoreSetup(receiptFile) {
  const receipt = regularFile(receiptFile);
  const directory = path.dirname(receipt);
  if (path.basename(receipt) !== 'receipt.json' || path.basename(path.dirname(directory)) !== 'backups' ||
      path.basename(path.dirname(path.dirname(directory))) !== '.easyeda-agent') {
    throw new Error('Use the receipt returned by this setup script.');
  }
  const profile = path.dirname(path.dirname(path.dirname(directory)));
  const target = regularFile(path.join(profile, 'cordis.patch.yml'));
  if (target !== path.join(profile, 'cordis.patch.yml')) throw new Error('Linked patch files are not restored.');
  const record = JSON.parse(readFileSync(receipt, 'utf8'));
  const backupPath = regularFile(path.join(directory, 'cordis.patch.yml'));
  if (backupPath !== path.join(directory, 'cordis.patch.yml')) throw new Error('Linked backup files are not restored.');
  const backup = readFileSync(backupPath);
  const current = readFileSync(target);
  if (record.schemaVersion !== 1 || hash(backup) !== record.beforeSHA256) throw new Error('Backup integrity check failed.');
  if (hash(current) === record.beforeSHA256) return { status: 'already-restored', target };
  if (hash(current) !== record.afterSHA256) throw new Error('Profile edited after install; refusing to overwrite newer changes.');
  atomicReplace(target, backup, current);
  return { status: 'restored-not-runtime-verified', target };
}

function probeRuntime(plan) {
  const options = { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    windowsHide: true, env: { ...process.env, EASYEDA_NO_AUTOSTART: '1' } };
  const nodeVersion = execFileSync(plan.node, ['--version'], options).trim();
  const numbers = /^v(\d+)\.(\d+)/.exec(nodeVersion);
  if (!numbers || Number(numbers[1]) < 20 || (Number(numbers[1]) === 20 && Number(numbers[2]) < 17)) {
    throw new Error('Node 20.17 or newer is required.');
  }
  const cliVersion = execFileSync(plan.cli, ['version'], options).trim();
  if (!/^easyeda-agent\s+\S+/.test(cliVersion)) throw new Error('Unexpected easyeda version output.');
  const actions = JSON.parse(execFileSync(plan.cli, ['actions'], options));
  if (!Array.isArray(actions) || !actions.length) throw new Error('Action catalog is missing.');
  return { nodeVersion, cliVersion, actionCount: actions.length };
}

export function main(argv) {
  const values = { profile: 'desktop', home: process.env.DSH_HOME || path.join(homedir(), '.dsh') };
  const flags = { '--profile': 'profile', '--dsh-home': 'home', '--source': 'source', '--easyeda-bin': 'cli', '--node-bin': 'node' };
  let apply = false;
  let restore;
  let setupOptions = 0;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') {
      console.log('node scripts/dsh-setup.mjs --easyeda-bin <absolute executable> [--profile desktop] [--dsh-home <home>] [--node-bin <node>] [--source <checkout>] [--apply]\nDefault: read-only preview and local runtime preflight. No PATH changes, downloads, daemon launch, Skill registration or DSH restart.\nRollback: node scripts/dsh-setup.mjs --restore <receipt.json>');
      return;
    }
    if (argv[i] === '--apply') { apply = true; continue; }
    if (argv[i] === '--restore') { restore = argv[++i]; if (!restore) throw new Error('Missing receipt.'); continue; }
    const key = flags[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Unknown option or missing value: ${argv[i]}`);
    values[key] = argv[++i];
    setupOptions++;
  }
  if (restore) {
    if (apply || setupOptions) throw new Error('Do not combine restore with setup options.');
    console.log(json(restoreSetup(restore)));
    return;
  }
  if (!values.cli || !path.isAbsolute(values.cli)) throw new Error('--easyeda-bin must be an explicit absolute path.');
  const plan = planSetup(values);
  const runtime = probeRuntime(plan);
  for (const warning of plan.warnings) console.error(`dsh-setup warning: ${warning}`);
  console.log(json({ ...(apply ? applySetup(plan) : { status: 'preview-only', target: plan.target }),
    changed: plan.changed, preview: plan.block, runtime, skill: plan.skill, warnings: plan.warnings,
    notVerified: ['DSH composed configuration and live tool discovery', 'Skill body loaded by model',
      'MCP handshake', 'EDA connection, save/reload, DRC and physical hardware'],
    next: 'Use the existing install-agent-skills.py --target dsh --scope design for Skills; do not combine this source route with the DSH bundle.' }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`dsh-setup: ${error.message}`); process.exitCode = 1; }
}
