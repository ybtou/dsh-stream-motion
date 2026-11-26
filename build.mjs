#!/usr/bin/env node
/**
 * Bundle the browser half into the format the host's module loader reads, and
 * copy the host half as it is.
 *
 * The factory wrapper is the loader's contract, not a choice: `id` must equal
 * the package name, the body is CommonJS, and the factory returns the module's
 * exports. React is external because the page's module table already holds it.
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import esbuild from 'esbuild'

const ROOT = import.meta.dirname
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const LIB = path.join(ROOT, 'lib')
const OUT = path.join(LIB, 'client.js')

const OPEN = `/**
 * Stream motion — characters fade in as they arrive, and the chat area's follow
 * is slid instead of jumping.
 * GENERATED FILE — do not edit. Source lives in src/; \`npm run build\` bundles it.
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(PACKAGE.name)},
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
`
const CLOSE = `    return module.exports
  },
})
`

const result = await esbuild.build({
  entryPoints: [path.join(ROOT, 'src', 'client.js')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'esnext',
  charset: 'utf8',
  minify: true,
  sourcemap: false,
  write: false,
  logLevel: 'silent',
  external: ['react', 'react-dom/client'],
  banner: { js: OPEN },
  footer: { js: CLOSE },
})

const bundle = result.outputFiles[0].text
// The bundle must parse before it is written: a running page swaps to it as is.
try {
  new vm.Script(bundle, { filename: 'lib/client.js' })
} catch (error) {
  fs.mkdirSync(LIB, { recursive: true })
  fs.writeFileSync(path.join(LIB, 'client.failed.js'), bundle)
  throw new Error(`bundle failed to parse (kept at lib/client.failed.js): ${error.message}`)
}

fs.mkdirSync(LIB, { recursive: true })
fs.writeFileSync(OUT, bundle)
fs.copyFileSync(path.join(ROOT, 'src', 'host.js'), path.join(LIB, 'host.js'))
console.log(`built lib/client.js (${Buffer.byteLength(bundle)} bytes) and lib/host.js`)
