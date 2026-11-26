// Token Radar's entrypoint (Node 22, standard library only).
//
// What it does, end to end:
//   1. reads the sealed snapshot — /input/snapshot.json by default, or the file or
//      directory --input names;
//   2. scores every pre-token protocol with the radar-2 model in lib/model.ts and
//      writes the ranked board to /output/board.json plus the dashboard's dataset
//      to /output/data.js;
//   3. copies this repository's dashboard/ and screenshots/ into /output;
//   4. writes /output/dossier.json last, with the vendored make.fun library, so the
//      dossier describes exactly the files the grader will read.
//
// The dashboard is a static page with no framework and no network. It reads the
// data.js this program writes, so the page and the board always show the same
// numbers: the board is the source of truth and the page is its mirror.
//
// radar-2 prices a protocol the way the market prices the ones that already
// trade. Its base multiple is the median market-cap / TVL of the live protocols
// in the same category (at least five of them), otherwise the median across all
// live protocols, clamped to [0.02, 1.5]; seven-day growth, age with no token
// and chain breadth adjust it from there. The board covers the whole watchlist
// plus every rankable pre-token protocol below the floor, and every row carries
// the multiple it was scored with, so the page can show the working and a reader
// can recompute any row by hand.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

// Where this file lives, so the dashboard and screenshots are found next to it.
const ROOT = fileURLToPath(new URL('.', import.meta.url));

// The gate's own caps, from reference/gate.json. The text cap shapes the dossier's
// bytes; the screenshot caps refuse a hand-in that is too large or too many.
const DASHBOARD_TEXT_BYTES = 65_536;
const SHOT_LIMIT = { max: 4, max_bytes: 524_288 };
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Read `--name value` or `--name=value` from the arguments, or take `fallback`. */
function flag(name: string, fallback: string): string {
  const argv = process.argv;
  const spot = argv.indexOf(`--${name}`);
  if (spot !== -1 && spot + 1 < argv.length) return argv[spot + 1]!;
  const joined = argv.find((a) => a.startsWith(`--${name}=`));
  return joined === undefined ? fallback : joined.slice(name.length + 3);
}

/** Fail with a message on stderr and a non-zero exit. */
function fail(message: string, code: number): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(code);
}

/**
 * Copy the regular files of one directory into another, skipping dotfiles, and
 * return the names copied. A missing source directory copies nothing.
 */
function copyDir(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const source = join(from, name);
    if (!statSync(source).isFile()) continue;
    copyFileSync(source, join(to, name));
    names.push(name);
  }
  return names;
}

/** Check the copied screenshots against the gate's shape, and fail if they miss. */
function checkShots(names: string[]): void {
  if (names.length < 3) {
    const plural = names.length === 1 ? '' : 's';
    fail(
      `screenshots/ holds ${names.length} image${plural}: hand in 3, the board, a detail view and a filtered view`,
      1,
    );
  }
  for (const name of names) {
    if (!SHOT_NAME.test(name)) {
      fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`, 1);
    }
  }
}

function main(): void {
  // Resolve the snapshot: --input names a file or a directory, default /input.
  const inputArg = flag('input', '/input');
  const snapshotPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
  if (!existsSync(snapshotPath)) {
    fail(
      `no snapshot at ${snapshotPath}: pass --input <snapshot.json|directory> or mount the sealed /input`,
      2,
    );
  }
  // Resolve the output directory: --output, else MAKEFUN_OUTPUT_DIR, else /output.
  const outDir = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

  const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
  const { board, radar } = buildRadar(snapshot);

  // Refuse to write a board the gate would not take, rather than handing one in.
  const issue = boardIssue(board, snapshot);
  if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`, 1);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
  writeFileSync(join(outDir, 'data.js'), dataScript(radar));

  copyDir(join(ROOT, 'dashboard'), join(outDir, 'dashboard'));
  const shots = copyDir(join(ROOT, 'screenshots'), join(outDir, 'screenshots'));
  checkShots(shots);

  // The dossier is written last: the scorer rebuilds it from this /output and
  // compares bytes, so it must describe exactly what is on disk now.
  writeFileSync(
    join(outDir, 'dossier.json'),
    buildDossier(outDir, {
      text_max_bytes: DASHBOARD_TEXT_BYTES,
      screenshots: SHOT_LIMIT,
      dashboard: { max_files: 400, max_bytes: 4_194_304 },
    }),
  );

  const priced = Object.keys(radar.multiples.categories).length;
  process.stdout.write(
    [
      `token radar: ${snapshot.protocols.length} protocols read, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)`,
      `token radar: market multiple ${radar.multiples.global.toFixed(3)}x (median of ${radar.multiples.global_n} live protocols), ${priced} categor${priced === 1 ? 'y' : 'ies'} priced on their own`,
      `token radar: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ${join(outDir, 'dashboard')} (3 files), ${join(outDir, 'screenshots')} (${shots.length} images) and ${join(outDir, 'dossier.json')}`,
      '',
    ].join('\n'),
  );
}

main();
