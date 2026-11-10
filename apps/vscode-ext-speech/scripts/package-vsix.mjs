// Stage a self-contained extension in build/vsix/ for `vsce package` (no node_modules needed at install time).
//
// - esbuild bundles src/extension.ts and src/sttWorker.ts (with @huggingface/transformers and onnxruntime-node) into
//   dist/. One bundle means one onnxruntime-common, which matters: onnxruntime-node hands its Tensor class to the
//   native binding, so transformers and the binding must share it.
// - transformers loads onnxruntime-node through createRequire, which esbuild cannot follow; the plugin rewrites that
//   to a plain require so it is bundled. The native binding's platform-templated require is rewritten to
//   ./onnxruntime_binding.node, and that file plus libonnxruntime.so.1 (found via RUNPATH $ORIGIN) are copied next
//   to the bundle.
// - sharp (image processing, required eagerly by transformers but unused for speech) is replaced by a stub.
// - The staged package.json is named EXTENSION_NAME (vsce does not accept the scoped workspace name). In the public
//   repo (github.com/anosic/speech-recorder) package.json already carries that name.
//
// Usage: yarn package (in this directory)   (then run vsce in build/vsix; see the printed command)
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Marketplace extension id is `${publisher}.${EXTENSION_NAME}`. The single definition: the public-repo export reads it.
const EXTENSION_NAME = 'speech-recorder';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const stage = join(root, 'build', 'vsix');
const require = createRequire(join(root, 'package.json'));

const platform = `${process.platform}-${process.arch}`;
const vsceTarget = { 'linux-x64': 'linux-x64', 'linux-arm64': 'linux-arm64', 'darwin-arm64': 'darwin-arm64', 'darwin-x64': 'darwin-x64', 'win32-x64': 'win32-x64' }[platform];
if (!vsceTarget) { throw new Error(`unsupported platform ${platform}`); }
const exe = process.platform === 'win32' ? 'speech-capture.exe' : 'speech-capture';

// Resolve onnxruntime-node the same way transformers does, so we ship the binding it was built against.
const transformersMain = require.resolve('@huggingface/transformers');
const ortNodeDir = dirname(createRequire(transformersMain).resolve('onnxruntime-node/package.json'));
const ortBinDir = join(ortNodeDir, 'bin', 'napi-v6', process.platform, process.arch);
const captureBin = resolve(root, '..', '..', 'target', 'release', exe);
for (const p of [ortBinDir, captureBin]) {
	if (!existsSync(p)) { throw new Error(`missing ${p}${p === captureBin ? ' (run: cargo build --release -p speech-capture from the Cargo workspace root)' : ''}`); }
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'dist'), { recursive: true });

const rewrites = {
	name: 'anosic-rewrites',
	setup(b) {
		// Use the CommonJS build (what the tsc dev build loads via require), not the ESM build esbuild would pick for
		// `import` statements, so the packaged extension runs the same code as the Extension Development Host.
		b.onResolve({ filter: /^@huggingface\/transformers$/ }, () => ({ path: transformersMain }));
		b.onResolve({ filter: /^sharp$/ }, () => ({ path: 'sharp', namespace: 'stub' }));
		b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
			contents: 'module.exports = function sharp() { throw new Error("sharp is not bundled in Anosic Speech Recorder (image processing is unused)"); };',
			loader: 'js',
		}));
		b.onResolve({ filter: /onnxruntime_binding\.node$/ }, () => ({ path: './onnxruntime_binding.node', external: true }));
		b.onLoad({ filter: /transformers\.node\.cjs$/ }, args => {
			const src = readFileSync(args.path, 'utf8');
			const out = src.replace('requireFromHere("onnxruntime-node")', 'require("onnxruntime-node")');
			if (out === src) { throw new Error('transformers: requireFromHere("onnxruntime-node") not found; update package-vsix.mjs'); }
			applied.add('transformers');
			return { contents: out, loader: 'js', resolveDir: dirname(args.path) };
		});
		b.onLoad({ filter: /onnxruntime-node[\\/]dist[\\/]binding\.js$/ }, args => {
			const src = readFileSync(args.path, 'utf8');
			const out = src.replace(/require\(`\.\.\/bin\/napi-v6\/\$\{process\.platform\}\/\$\{process\.arch\}\/onnxruntime_binding\.node`\)/, 'require("./onnxruntime_binding.node")');
			if (out === src) { throw new Error('onnxruntime-node: binding require not found; update package-vsix.mjs'); }
			applied.add('binding');
			return { contents: out, loader: 'js', resolveDir: dirname(args.path) };
		});
	},
};

const applied = new Set();
const result = await build({
	entryPoints: { extension: join(root, 'src', 'extension.ts'), sttWorker: join(root, 'src', 'sttWorker.ts') },
	outdir: join(stage, 'dist'),
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node20',
	external: ['vscode'],
	plugins: [rewrites],
	metafile: true,
	logLevel: 'warning',
});
for (const r of ['transformers', 'binding']) {
	if (!applied.has(r)) { throw new Error(`rewrite "${r}" never ran: esbuild resolved a different file than expected`); }
}
for (const [file, info] of Object.entries(result.metafile.outputs)) {
	console.log(`  ${file.replace(stage + '/', '')}  ${(info.bytes / 1e6).toFixed(2)} MB`);
}

for (const f of ['onnxruntime_binding.node', process.platform === 'linux' ? 'libonnxruntime.so.1' : null].filter(Boolean)) {
	cpSync(join(ortBinDir, f), join(stage, 'dist', f));
}
if (process.platform !== 'linux') {
	// Other platforms ship differently named runtime libraries; copy everything in the binding dir.
	cpSync(ortBinDir, join(stage, 'dist'), { recursive: true });
}
mkdirSync(join(stage, 'bin'));
cpSync(captureBin, join(stage, 'bin', exe));
cpSync(join(root, 'media'), join(stage, 'media'), { recursive: true });
cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));
// Relative links point into the source tree and mean nothing in an installed extension: keep the link text, drop
// the target. Absolute http(s) links are kept.
// CHANGELOG.md gets the same treatment; VS Code shows it as the extension's Changelog tab.
for (const doc of ['README.md', 'CHANGELOG.md']) {
	writeFileSync(join(stage, doc), readFileSync(join(root, doc), 'utf8').replace(/\[([^\]]+)\]\((?!https?:)[^)]*\)/g, '$1'));
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const staged = {
	name: EXTENSION_NAME,
	displayName: pkg.displayName,
	description: pkg.description,
	version: pkg.version,
	publisher: pkg.publisher,
	author: pkg.author,
	license: pkg.license,
	repository: pkg.repository,
	homepage: pkg.homepage,
	bugs: pkg.bugs,
	engines: pkg.engines,
	extensionKind: pkg.extensionKind,
	categories: pkg.categories,
	keywords: pkg.keywords,
	icon: pkg.icon,
	galleryBanner: pkg.galleryBanner,
	activationEvents: pkg.activationEvents,
	main: './dist/extension.js',
	contributes: pkg.contributes,
};
writeFileSync(join(stage, 'package.json'), JSON.stringify(staged, null, '\t') + '\n');

const vsix = `${EXTENSION_NAME}-${vsceTarget}-${pkg.version}.vsix`;
console.log(`\nstaged ${stage}\nnext (network: downloads vsce):\n  cd ${stage} && yarn dlx @vscode/vsce package --no-dependencies --target ${vsceTarget} --out ../${vsix}`);
