#!/usr/bin/env node

/**
 * Build script: imports each workflow definition from workflows/ and writes
 * the compiled n8n JSON to output/.
 *
 * Usage:
 *   node build.js                        # build all workflows
 *   node build.js --workflow my-flow      # build a single workflow by filename (without .js)
 */

import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const WORKFLOWS_DIR = join(process.cwd(), 'workflows');
const OUTPUT_DIR = join(process.cwd(), 'output');

async function buildWorkflow(filePath) {
  const mod = await import(pathToFileURL(filePath).href);
  const workflow = mod.default;

  if (!workflow || !workflow.name) {
    console.warn(`  Skipping ${filePath}: no default export with a "name" property`);
    return null;
  }

  const outName = basename(filePath, '.js') + '.json';
  const outPath = join(OUTPUT_DIR, outName);
  await writeFile(outPath, JSON.stringify(workflow, null, 2) + '\n');
  console.log(`  ${basename(filePath)} -> output/${outName}`);
  return outName;
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const args = process.argv.slice(2);
  const singleIdx = args.indexOf('--workflow');
  const singleName = singleIdx !== -1 ? args[singleIdx + 1] : null;

  if (singleName) {
    const filePath = join(WORKFLOWS_DIR, singleName + '.js');
    console.log(`Building workflow: ${singleName}`);
    await buildWorkflow(filePath);
  } else {
    const files = (await readdir(WORKFLOWS_DIR)).filter(f => f.endsWith('.js')).sort();
    if (files.length === 0) {
      console.log('No workflow files found in workflows/. Create a .js file there to get started.');
      return;
    }
    console.log(`Building ${files.length} workflow(s)...`);
    for (const file of files) {
      await buildWorkflow(join(WORKFLOWS_DIR, file));
    }
  }

  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
