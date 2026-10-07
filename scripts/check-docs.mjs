import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const documents = collectMarkdownFiles(root);
const findings = [];
let linkCount = 0;
let scriptCount = 0;

for (const document of documents) {
  const text = readFileSync(document.absolutePath, "utf8");
  for (const link of findLinks(text)) {
    linkCount += 1;
    checkLink(root, document, link, findings);
  }
  for (const command of findNpmRunCommands(text)) {
    scriptCount += 1;
    if (!(command.name in packageJson.scripts)) {
      findings.push({
        file: document.path,
        line: command.line,
        message: `npm run ${command.name} is not defined in package.json`,
      });
    }
  }
}

checkGeneratedCache(root, documents, findings);
checkCurrentMobileSchema(root, documents, findings);

findings.sort((left, right) =>
  left.file.localeCompare(right.file) || left.line - right.line || left.message.localeCompare(right.message));

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}: ${finding.message}`);
  }
  console.error(
    `check-docs: FAIL (${findings.length} issue${findings.length === 1 ? "" : "s"}, ` +
      `${documents.length} Markdown files, ${linkCount} link references, ${scriptCount} npm run references)`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `check-docs: PASS (${documents.length} Markdown files, ${linkCount} link references, ` +
      `${scriptCount} npm run references)`,
  );
}

function collectMarkdownFiles(repositoryRoot) {
  const files = [];
  visit(repositoryRoot);
  return files.sort((left, right) => left.path.localeCompare(right.path));

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push({
          absolutePath,
          path: relative(repositoryRoot, absolutePath).split("\\").join("/"),
        });
      }
    }
  }
}

function findLinks(text) {
  const links = [];
  let inFence = false;
  let offset = 0;

  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      offset += line.length + 1;
      continue;
    }
    if (inFence) {
      offset += line.length + 1;
      continue;
    }

    const pattern = /!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+[^)]*)?\)/g;
    for (const match of line.matchAll(pattern)) {
      const rawTarget = match[1];
      const target = rawTarget.startsWith("<") ? rawTarget.slice(1, -1) : rawTarget;
      links.push({
        target,
        line: lineNumber(text, offset + match.index),
      });
    }
    offset += line.length + 1;
  }

  return links;
}

function findNpmRunCommands(text) {
  return [...text.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g)].map((match) => ({
    name: match[1],
    line: lineNumber(text, match.index),
  }));
}

function checkLink(repositoryRoot, document, link, findings) {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(link.target) || link.target.startsWith("//")) return;

  const hashIndex = link.target.indexOf("#");
  const pathPart = hashIndex === -1 ? link.target : link.target.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : decode(link.target.slice(hashIndex + 1));
  const targetPath = pathPart ? decode(pathPart) : document.path;
  const absoluteTarget = resolve(repositoryRoot, dirname(document.path), targetPath);

  if (!existsSync(absoluteTarget)) {
    findings.push({
      file: document.path,
      line: link.line,
      message: `local link target does not exist: ${link.target}`,
    });
    return;
  }
  if (!fragment) return;

  const targetText = readFileSync(absoluteTarget, "utf8");
  if (!headingSlugs(targetText).has(fragment.toLowerCase())) {
    findings.push({
      file: document.path,
      line: link.line,
      message: `link fragment does not exist: ${link.target}`,
    });
  }
}

function headingSlugs(text) {
  const slugs = new Set();
  const counts = new Map();
  let inFence = false;

  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const slug = match[1]
      .replace(/[`*_~]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-");
    const count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    slugs.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return slugs;
}

function checkGeneratedCache(repositoryRoot, documents, findings) {
  const build = readFileSync(resolve(repositoryRoot, "build-mobile.mjs"), "utf8");
  const serviceWorker = readFileSync(resolve(repositoryRoot, "mobile/service-worker.js"), "utf8");
  const version = build.match(/const CACHE_VERSION = ["']([^"']+)["']/)?.[1];
  const generatedName = serviceWorker.match(/const CACHE_NAME = ["']([^"']+)["']/)?.[1];
  if (!version || !generatedName) {
    findings.push({ file: "build-mobile.mjs", line: 1, message: "could not read the mobile cache version" });
    return;
  }

  const expectedName = `offline-pgn-reader-mobile-${version}`;
  if (generatedName !== expectedName) {
    findings.push({
      file: "mobile/service-worker.js",
      line: 1,
      message: `generated cache is ${generatedName}, expected ${expectedName}`,
    });
  }

  for (const document of documents) {
    const text = readFileSync(document.absolutePath, "utf8");
    for (const match of text.matchAll(/offline-pgn-reader-mobile-v[0-9]+/g)) {
      if (match[0] !== expectedName) {
        findings.push({
          file: document.path,
          line: lineNumber(text, match.index),
          message: `documented mobile cache is ${match[0]}, expected ${expectedName}`,
        });
      }
    }
  }
}

function checkCurrentMobileSchema(repositoryRoot, documents, findings) {
  const source = readFileSync(resolve(repositoryRoot, "src/mobile/storage.ts"), "utf8");
  const schemaVersion = source.match(/MOBILE_STORAGE_SCHEMA_VERSION\s*=\s*(\d+)/)?.[1];
  if (!schemaVersion) {
    findings.push({ file: "src/mobile/storage.ts", line: 1, message: "could not read the current Mobile Library schema" });
    return;
  }

  const currentSchema = /(?:current (?:Mobile Library )?(?:snapshot )?schema|currently schema|IndexedDB schema)\s*(?:is\s*)?v(\d+)/gi;
  for (const document of documents) {
    const text = readFileSync(document.absolutePath, "utf8");
    for (const match of text.matchAll(currentSchema)) {
      if (match[1] !== schemaVersion) {
        findings.push({
          file: document.path,
          line: lineNumber(text, match.index),
          message: `documented current Mobile Library schema is v${match[1]}, expected v${schemaVersion}`,
        });
      }
    }
  }
}

function lineNumber(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
