/**
 * Turn the CHANGELOG's `## [Unreleased]` section into a dated `## [X.Y.Z]` one, and add
 * its compare link, so a release never needs a hand-written follow-up PR for it.
 *
 * Run by .github/workflows/publish.yml before the release commit. Idempotent: a version
 * that already has a section is left alone, so a re-run of a partly failed publish is safe.
 *
 *   node scripts/date-changelog.mjs 0.17.7
 */

import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$/.test(version)) {
  console.error('usage: node scripts/date-changelog.mjs <version>');
  process.exit(1);
}

const FILE = 'CHANGELOG.md';
const REPO = 'https://github.com/unicity-sphere/sphere-sdk';
const text = readFileSync(FILE, 'utf-8');
const eol = text.includes('\r\n') ? '\r\n' : '\n';
const nl = (s) => (eol === '\n' ? s : s.replace(/\n/g, eol));

if (text.includes(nl(`## [${version}]`))) {
  console.log(`CHANGELOG already has a [${version}] section — nothing to do`);
  process.exit(0);
}

const heading = nl('## [Unreleased]\n');
if (!text.includes(heading)) {
  console.error(`CHANGELOG has no "## [Unreleased]" section — cannot date v${version}`);
  process.exit(1);
}

// The version this release follows, taken from the link the Unreleased section compares
// against. Keeping it as the source of truth means the footer stays a chain even when a
// release is cut from an older tag.
const unreleasedLink = new RegExp(`^\\[Unreleased\\]: ${REPO}/compare/v(.+?)\\.\\.\\.HEAD$`, 'm');
const previous = text.match(unreleasedLink)?.[1];
if (!previous) {
  console.error('CHANGELOG footer has no [Unreleased] compare link — cannot chain the links');
  process.exit(1);
}

const date = new Date().toISOString().slice(0, 10);
const body = text
  .replace(heading, `${heading}${eol}${nl(`## [${version}] - ${date}`)}${eol}`)
  .replace(
    unreleasedLink,
    `[Unreleased]: ${REPO}/compare/v${version}...HEAD${eol}[${version}]: ${REPO}/compare/v${previous}...v${version}`,
  );

// The section is dated even when it is empty: an empty release entry is honest, and
// failing the publish over it would strand an already-published npm version.
const section = body.split(nl(`## [${version}] - ${date}`))[1]?.split(nl('\n## ['))[0] ?? '';
if (section.trim() === '') {
  console.warn(`WARNING: [${version}] is empty — nothing was listed under [Unreleased]`);
}

writeFileSync(FILE, body);
console.log(`CHANGELOG: [Unreleased] -> [${version}] - ${date} (previous: v${previous})`);
