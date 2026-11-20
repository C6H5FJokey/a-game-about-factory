import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

async function filesUnder(directory, suffix) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path, suffix));
    else if (entry.name.endsWith(suffix)) files.push(resolve(path));
  }
  return files.sort();
}

const generated = resolve('src/generated-content.ts');
const tsFiles = (await filesUnder('src', '.ts')).filter(file => file !== generated);
const tsFileSet = new Set(tsFiles);
const tsModules = new Map();
for (const file of tsFiles) {
  const source = await readFile(file, 'utf8');
  const imports = new Set();
  for (const { fileName } of ts.preProcessFile(source).importedFiles) {
    if (!fileName.startsWith('.')) continue;
    const path = resolve(dirname(file), fileName);
    const target = [path, path + '.ts', join(path, 'index.ts')].find(candidate => tsFileSet.has(candidate));
    if (target) imports.add(target);
  }
  tsModules.set(file, { imports, nonBlankLines: source.split(/\r?\n/).filter(line => line.trim()).length });
}

function reaches(from, target, visited) {
  if (from === target) return true;
  if (visited.has(from)) return false;
  visited.add(from);
  return [...tsModules.get(from).imports].some(file => reaches(file, target, visited));
}

const cyclic = [...tsModules].filter(([file, { imports }]) => {
  const visited = new Set();
  return [...imports].some(imported => reaches(imported, file, visited));
}).map(([file]) => relative('.', file));
const worldImplementations = [];
for (const file of await filesUnder('sim/src', '.rs')) {
  const source = await readFile(file, 'utf8');
  if (/^impl World\s*\{/m.test(source)) worldImplementations.push(relative('.', file));
}

const entry = tsModules.get(resolve('src/main.ts'));
const nonBlankLines = [...tsModules.values()].reduce((total, module) => total + module.nonBlankLines, 0);
console.log(JSON.stringify({
  authoredTsModules: tsModules.size,
  authoredTsNonBlankLines: nonBlankLines,
  entryModule: { nonBlankLines: entry.nonBlankLines, localImports: entry.imports.size },
  modulesInRelativeImportCycles: cyclic,
  rustFilesImplementingWorld: worldImplementations,
}, null, 2));
