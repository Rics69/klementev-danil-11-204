import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type CliOptions = {
  lemmasDir: string;
  out: string;
};

function parseArgs(argv: string[]): CliOptions {
  const get = (name: string): string | undefined => {
    const idx = argv.indexOf(`--${name}`);
    if (idx === -1) return undefined;
    return argv[idx + 1];
  };

  return {
    lemmasDir: get("lemmasDir") ?? "lemmas_by_doc",
    out: get("out") ?? "inverted_index.txt"
  };
}

function getDocIdFromFilename(filename: string): string | null {
  const m = filename.match(/^(\d+)\.lemmas\.txt$/);
  return m ? m[1] : null;
}

function normalizeToken(token: string): string {
  return token.toLocaleLowerCase("ru-RU");
}

async function buildInvertedIndex(lemmasDir: string): Promise<Map<string, Set<string>>> {
  const entries = await readdir(lemmasDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".lemmas.txt"))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, "ru-RU"));

  if (files.length === 0) {
    throw new Error(`В папке ${lemmasDir} нет файлов *.lemmas.txt`);
  }

  const index = new Map<string, Set<string>>();

  for (const file of files) {
    const docId = getDocIdFromFilename(file);
    if (!docId) continue;

    const fullPath = path.join(lemmasDir, file);
    const raw = await readFile(fullPath, "utf8");
    const lines = raw.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const lemma = normalizeToken(trimmed.split(/\s+/)[0] ?? "");
      if (!lemma) continue;

      if (!index.has(lemma)) {
        index.set(lemma, new Set<string>());
      }
      index.get(lemma)!.add(docId);
    }
  }

  return index;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const index = await buildInvertedIndex(opts.lemmasDir);

  const lemmas = Array.from(index.keys()).sort((a, b) => a.localeCompare(b, "ru-RU"));
  const lines: string[] = [];

  for (const lemma of lemmas) {
    const docs = Array.from(index.get(lemma) ?? []).sort((a, b) =>
      a.localeCompare(b, "ru-RU")
    );
    lines.push(`${lemma}\t${docs.join(" ")}`);
  }

  await writeFile(opts.out, lines.join("\n") + "\n", "utf8");
  process.stdout.write(
    `Готово. Лемм: ${lemmas.length}. Файл индекса: ${opts.out}\n`
  );
}

await main();
