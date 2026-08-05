/**
 * Loads the *shipped* `src/app/workload-generator.ts` into Node, unchanged.
 *
 * This matters more than it looks. The alternative — keeping a JavaScript copy of the algorithm
 * beside the benchmark — means every measurement is of a fork, and the fork silently stops matching
 * the moment anyone edits either side. Here there is one implementation, the browser and the
 * benchmark both run it, and a number in the results table is a number about the product.
 *
 * Two routes, tried in order:
 *
 *  1. **Node's own type stripping** (`module.stripTypeScriptTypes`, Node 22.13+). No dependency, no
 *     configuration, no TypeScript package involved at all. It only works on *erasable* TypeScript —
 *     no enums, no namespaces, no constructor parameter properties — and `workload-generator.ts` is
 *     deliberately written that way, which is worth preserving if you edit it.
 *  2. **The TypeScript compiler's `transpileModule`**, if the project's own `typescript` devDependency
 *     is present and exposes the classic API. Handles anything route 1 will not.
 *
 * The generator has no imports of its own, so transpiling that one file is enough: no bundler, no
 * `tsconfig`, no build step.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));

/** `timetable-ui/src/app/workload-generator.ts`, from `timetable-ui/scripts/workload-bench/lib/`. */
export const GENERATOR_PATH = resolve(HERE, '../../../src/app/workload-generator.ts');

let cached = null;

/**
 * @param {string} path  the .ts file to load
 * @returns {Promise<{ generateWorkloads: Function, module: object, via: string, source: string, bytes: number }>}
 */
export async function loadGenerator(path = GENERATOR_PATH) {
  if (cached && cached.path === path) return cached;

  const source = readFileSync(path, 'utf8');
  let js = null;
  let via = null;
  const problems = [];

  if (typeof stripTypeScriptTypes === 'function') {
    try {
      js = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: pathToFileURL(path).href });
      via = `node ${process.version} type stripping`;
    } catch (e) {
      problems.push(`node type stripping: ${e.message}`);
    }
  }

  if (js === null) {
    try {
      const mod = await import('typescript');
      const ts = mod.transpileModule ? mod : mod.default;
      if (!ts || typeof ts.transpileModule !== 'function') {
        throw new Error(`typescript ${mod.version ?? mod.default?.version ?? '?'} does not expose transpileModule`);
      }
      const out = ts.transpileModule(source, {
        fileName: path,
        reportDiagnostics: true,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          removeComments: false
        }
      });
      const fatal = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
      if (fatal.length) {
        throw new Error(fatal.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; '));
      }
      js = out.outputText;
      via = `typescript ${ts.version} transpileModule`;
    } catch (e) {
      problems.push(`typescript: ${e.message}`);
    }
  }

  if (js === null) {
    throw new Error(`Cannot load ${path}.\n  ${problems.join('\n  ')}`);
  }

  // No imports in the module, so a data: URL is enough and leaves nothing on disk to go stale.
  const url = `data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`;
  const mod = await import(url);

  if (typeof mod.generateWorkloads !== 'function') {
    throw new Error(`${path} does not export generateWorkloads`);
  }

  cached = { path, generateWorkloads: mod.generateWorkloads, module: mod, via, source, bytes: source.length };
  return cached;
}
