import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, copyFile, mkdir, readdir, lstat, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// This script is copied to scripts/ in the standalone repository. Validate the
// packed artifact in an independent consumer, never through monorepo aliases.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'riadchain-sdk-consumer-'));
const consumer = join(temporary, 'consumer');
const registry = 'https://registry.npmjs.org/';
const environment = { ...process.env };
for (const key of Object.keys(environment)) {
  if (/^npm_config_/i.test(key) || ['NODE_PATH', 'NODE_OPTIONS', 'TS_NODE_PROJECT', 'TS_NODE_COMPILER_OPTIONS'].includes(key)) {
    delete environment[key];
  }
}
const publicExports = Object.entries(manifest.exports ?? {});

function run(command, args, cwd = consumer) {
  return execFileSync(command, args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: 300_000,
  });
}

function targets(value) {
  return typeof value === 'string' ? [value] : Object.values(value ?? {}).flatMap(targets);
}

async function verifyProvenance() {
  const provenance = JSON.parse(await readFile(join(root, 'SOURCE.json'), 'utf8'));
  assert(provenance && typeof provenance === 'object' && !Array.isArray(provenance), 'SOURCE.json must be an object');
  assert.deepEqual(Object.keys(provenance).sort(), ['commit', 'dirty', 'files', 'protocolSchemaSHA256', 'repository'], 'Unexpected SOURCE.json fields');
  assert.equal(provenance.repository, 'https://github.com/nfl0/riadchain');
  assert(typeof provenance.commit === 'string' && /^[0-9a-f]{40}$/.test(provenance.commit), 'Invalid source commit');
  assert.equal(typeof provenance.dirty, 'boolean', 'Source dirty flag must be boolean');
  assert(typeof provenance.protocolSchemaSHA256 === 'string' && /^[0-9a-f]{64}$/.test(provenance.protocolSchemaSHA256), 'Invalid protocol schema SHA-256');
  assert(provenance.files && typeof provenance.files === 'object' && !Array.isArray(provenance.files), 'Source file checksums must be an object');
  const declared = Object.keys(provenance.files).sort();
  assert(declared.length > 0, 'Source provenance must not be empty');
  for (const path of declared) {
    assert(/^(?:sdk|lib)\/[A-Za-z0-9_./-]+\.ts$/.test(path)
      && !path.split('/').some((part) => part === '.' || part === '..' || part === ''), `Invalid provenance source path: ${path}`);
    assert(typeof provenance.files[path] === 'string' && /^[0-9a-f]{64}$/.test(provenance.files[path]), `Invalid source SHA-256: ${path}`);
  }
  const sourceRoot = join(root, 'src');
  assert((await lstat(sourceRoot)).isDirectory(), 'src must be a real source directory');
  async function sourceFiles(directory, prefix = '') {
    const found = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) found.push(...await sourceFiles(join(directory, entry.name), `${path}/`));
      else {
        assert(entry.isFile(), `Source must not contain links or special files: ${path}`);
        found.push(path);
      }
    }
    return found;
  }
  assert.deepEqual((await sourceFiles(sourceRoot)).sort(), declared, 'Source file set does not match SOURCE.json');
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256(await readFile(join(root, 'proto/riadchain.proto'))), provenance.protocolSchemaSHA256, 'Protocol schema does not match SOURCE.json');
  for (const path of declared) {
    assert.equal(sha256(await readFile(join(sourceRoot, path))), provenance.files[path], `Source checksum mismatch: ${path}`);
  }
}

try {
  assert.equal(manifest.name, '@riadchain/sdk');
  assert.notEqual(manifest.private, true, 'The standalone package must be publishable');
  assert(publicExports.length > 0, 'The SDK must declare its public exports');
  assert(manifest.devDependencies?.['@types/node'], 'Pin @types/node for the isolated declaration consumer');
  await verifyProvenance();
  await mkdir(consumer);
  const userConfig = join(temporary, 'user.npmrc');
  const globalConfig = join(temporary, 'global.npmrc');
  await writeFile(userConfig, '');
  await writeFile(globalConfig, '');
  Object.assign(environment, {
    npm_config_registry: registry,
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    npm_config_cache: join(temporary, 'npm-cache'),
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  });

  const packOutput = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], root));
  // npm 10/11 return an array; npm 12 keys the same records by package name.
  const packages = Array.isArray(packOutput) ? packOutput : Object.values(packOutput);
  assert.equal(packages.length, 1, 'Verification must pack exactly one standalone SDK');
  const [packed] = packages;
  assert(packed?.filename && Array.isArray(packed.files), 'npm pack did not describe one package');
  assert.equal(packed.name, manifest.name);
  assert.equal(packed.version, manifest.version);
  const paths = new Set(packed.files.map(({ path }) => path));
  for (const path of paths) {
    assert(!path.split('/').includes('..') && !path.startsWith('/'), `Unsafe packed path: ${path}`);
    assert(
      /^(?:package\.json|SOURCE\.json|README\.md|LICENSE(?:\.md)?|NOTICE(?:\.md)?)$/.test(path)
        || /^dist\/.+\.(?:js|d\.ts)(?:\.map)?$/.test(path)
        || /^src\/(?:sdk|lib)\/(?!.*(?:\.test\.|\.spec\.))[^\n]+\.ts$/.test(path)
        || path === 'proto/riadchain.proto',
      `Unexpected packed content: ${path}`,
    );
  }
  for (const required of ['package.json', 'SOURCE.json', 'README.md', 'LICENSE', 'proto/riadchain.proto']) {
    assert(paths.has(required), `Package is missing ${required}`);
  }
  for (const [subpath, definition] of publicExports) {
    assert(subpath === '.' || /^\.\/[a-zA-Z0-9/-]+$/.test(subpath), `Unsupported public subpath: ${subpath}`);
    const exported = targets(definition);
    assert(exported.some((target) => target.endsWith('.js')), `Missing JavaScript export: ${subpath}`);
    assert(exported.some((target) => target.endsWith('.d.ts')), `Missing declaration export: ${subpath}`);
    for (const target of exported) {
      assert(/^\.\/dist\/.+\.(?:js|d\.ts)$/.test(target), `Non-compiled export: ${subpath} -> ${target}`);
      assert(paths.has(target.slice(2)), `Unpacked export target: ${subpath} -> ${target}`);
    }
  }
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    assert(!/^(?:file:|link:|workspace:|https?:|git[+:])/.test(version), `Non-registry runtime dependency: ${name}`);
  }

  await writeFile(join(consumer, 'package.json'), JSON.stringify({
    name: 'riadchain-sdk-isolated-consumer',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: { '@riadchain/sdk': `file:${join(temporary, packed.filename)}` },
    devDependencies: { '@types/node': manifest.devDependencies['@types/node'] },
  }, null, 2));
  // Explicit public registry and disabled scripts keep this a consumer install,
  // without reusing the release workspace's dependency tree or credentials.
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', `--registry=${registry}`]);
  const installed = await realpath(join(consumer, 'node_modules/@riadchain/sdk'));
  assert(installed.startsWith(`${await realpath(consumer)}${sep}`), 'The installed SDK must not link to its source checkout');
  assert(!installed.startsWith(`${await realpath(root)}${sep}`), 'Consumer must be outside the release repository');
  for (const filename of ['consumer.test.mjs', 'consumer.ts', 'browser.mjs']) {
    await copyFile(join(root, 'fixtures', filename), join(consumer, filename));
  }
  await writeFile(join(consumer, 'exports.json'), JSON.stringify(publicExports.map(([subpath]) =>
    subpath === '.' ? manifest.name : `${manifest.name}${subpath.slice(1)}`)));
  const types = await readFile(join(consumer, 'consumer.ts'), 'utf8');
  await writeFile(join(consumer, 'consumer.ts'), `${types}\n${publicExports.map(([subpath], index) => {
    const specifier = subpath === '.' ? manifest.name : `${manifest.name}${subpath.slice(1)}`;
    return `import * as publicExport${index} from ${JSON.stringify(specifier)};\nvoid publicExport${index};`;
  }).join('\n')}\n`);
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      types: ['node'],
    },
    files: ['consumer.ts'],
  }, null, 2));
  run(process.execPath, ['--test', 'consumer.test.mjs']);
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--project', join(consumer, 'tsconfig.json')]);
  const bundled = await build({
    absWorkingDir: consumer,
    entryPoints: ['browser.mjs'],
    outfile: join(consumer, 'browser.bundle.mjs'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    metafile: true,
    write: true,
    logLevel: 'silent',
  });
  for (const [input, metadata] of Object.entries(bundled.metafile.inputs)) {
    assert(!/(?:^|[\\/])(?:bun-ffi|bun-ffi-charlie|node-ffi)(?:[\\/]|$)/.test(input), `Native browser input: ${input}`);
    for (const imported of metadata.imports) {
      assert(!imported.external, `Unresolved browser dependency: ${imported.path}`);
      assert(!/^(?:node:|bun:)/.test(imported.path), `Native browser dependency: ${imported.path}`);
    }
  }
  // Execute the bundled browser entry without Node globals. The fixture uses
  // real crypto/codecs and a memory-only transport, not network RPC or keys.
  environment.RIADCHAIN_VERIFY_BROWSER_BUNDLE = '1';
  run(process.execPath, ['--test', 'consumer.test.mjs']);
  console.log(JSON.stringify({
    verified: true,
    package: `${manifest.name}@${manifest.version}`,
    publicExports: publicExports.length,
    packedFiles: paths.size,
    sourceProvenance: true,
    isolatedInstall: true,
    nodeNextDeclarations: true,
    browserBundle: true,
  }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
