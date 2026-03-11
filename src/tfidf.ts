import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { decode } from "html-entities";
import stopword from "stopword";

type CliOptions = {
  inDir: string;
  tokensFile: string;
  lemmasFile: string;
  termsOutDir: string;
  lemmasOutDir: string;
  minLen: number;
};

type DocStats = {
  docId: string;
  termCounts: Map<string, number>;
  totalTerms: number;
};

const TOKEN_RE = /\p{L}+(?:-\p{L}+)*/gu;

const EXTRA_STOPWORDS_RU = [
  "г",
  "гг",
  "год",
  "года",
  "лет",
  "ул",
  "км",
  "м",
  "тыс",
  "млн",
  "млрд"
];

const EXTRA_STOPWORDS_EN = ["etc", "eg", "ie"];

function parseArgs(argv: string[]): CliOptions {
  const get = (name: string): string | undefined => {
    const idx = argv.indexOf(`--${name}`);
    if (idx === -1) return undefined;
    return argv[idx + 1];
  };

  const minLenRaw = get("minLen") ?? "2";
  const minLen = Number(minLenRaw);
  if (!Number.isFinite(minLen) || minLen < 1) {
    throw new Error(`Некорректный --minLen: ${minLenRaw}`);
  }

  return {
    inDir: get("inDir") ?? "dump",
    tokensFile: get("tokensFile") ?? "tokens.txt",
    lemmasFile: get("lemmasFile") ?? "lemmas.txt",
    termsOutDir: get("termsOutDir") ?? "tfidf_terms_by_doc",
    lemmasOutDir: get("lemmasOutDir") ?? "tfidf_lemmas_by_doc",
    minLen
  };
}

function normalizeToken(token: string): string {
  return token.toLocaleLowerCase("ru-RU");
}

function sanitizeHtml(html: string): string {
  const withoutBlocks = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const textOnly = withoutBlocks.replace(/<[^>]+>/g, " ");
  return decode(textOnly).replace(/\s+/g, " ").trim();
}

function buildStopwordSet(): Set<string> {
  const { eng: STOP_EN, rus: STOP_RU } = stopword as {
    eng: string[];
    rus: string[];
  };
  const all = [
    ...STOP_RU,
    ...STOP_EN,
    ...EXTRA_STOPWORDS_RU,
    ...EXTRA_STOPWORDS_EN
  ];
  return new Set(all.map(normalizeToken));
}

function isCleanToken(token: string): boolean {
  if (!/^[a-zа-яё-]+$/i.test(token)) return false;
  if (!/^[a-zа-яё]+(?:-[a-zа-яё]+)*$/i.test(token)) return false;

  const hasCyr = /[а-яё]/i.test(token);
  const hasLat = /[a-z]/i.test(token);
  if (hasCyr && hasLat) return false;

  return hasCyr || hasLat;
}

function getDocIdFromFileName(name: string): string | null {
  const stem = path.parse(name).name;
  if (!/^\d+$/.test(stem)) return null;
  return stem;
}

function parseTerms(tokensRaw: string): string[] {
  return tokensRaw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseLemmasAndTokenToLemma(lemmasRaw: string): {
  lemmas: string[];
  tokenToLemma: Map<string, string>;
} {
  const lemmas: string[] = [];
  const tokenToLemma = new Map<string, string>();
  const lines = lemmasRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

  for (const line of lines) {
    const parts = line.split(/\s+/);
    const lemma = parts[0];
    if (!lemma) continue;
    lemmas.push(lemma);

    const tokens = parts.slice(1);
    for (const token of tokens) {
      if (!token) continue;
      tokenToLemma.set(token, lemma);
    }
  }

  return { lemmas, tokenToLemma };
}

function computeIdf(totalDocs: number, docFrequency: number): number {
  if (docFrequency <= 0) return 0;
  return Math.log(totalDocs / docFrequency);
}

function formatFloat(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(8);
}

async function writeTfidfFile(
  outPath: string,
  entries: Iterable<string>,
  totalTermsInDoc: number,
  counts: Map<string, number>,
  idfByItem: Map<string, number>
): Promise<void> {
  const out = createWriteStream(outPath, { encoding: "utf8" });
  for (const item of entries) {
    const count = counts.get(item) ?? 0;
    const tf = totalTermsInDoc > 0 ? count / totalTermsInDoc : 0;
    const idf = idfByItem.get(item) ?? 0;
    const tfidf = tf * idf;
    if (!out.write(`${item} ${formatFloat(idf)} ${formatFloat(tfidf)}\n`)) {
      await once(out, "drain");
    }
  }
  out.end();
  await once(out, "finish");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const stopwords = buildStopwordSet();
  const collator = new Intl.Collator("ru-RU");

  const [tokensRaw, lemmasRaw] = await Promise.all([
    readFile(opts.tokensFile, "utf8"),
    readFile(opts.lemmasFile, "utf8")
  ]);

  const terms = parseTerms(tokensRaw).sort((a, b) => collator.compare(a, b));
  const { lemmas, tokenToLemma } = parseLemmasAndTokenToLemma(lemmasRaw);
  lemmas.sort((a, b) => collator.compare(a, b));

  const termSet = new Set(terms);
  const lemmaSet = new Set(lemmas);

  const entries = await readdir(opts.inDir, { withFileTypes: true });
  const docFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".txt"))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, "ru-RU"));

  if (docFiles.length === 0) {
    throw new Error(`В папке ${opts.inDir} нет .txt файлов`);
  }

  const docs: DocStats[] = [];
  const termDf = new Map<string, number>();
  const lemmaDf = new Map<string, number>();
  const lemmaCountsByDoc = new Map<string, Map<string, number>>();

  for (const file of docFiles) {
    const docId = getDocIdFromFileName(file);
    if (!docId) continue;

    const p = path.join(opts.inDir, file);
    const html = await readFile(p, "utf8");
    const text = sanitizeHtml(html);
    const matches = text.match(TOKEN_RE) ?? [];

    const termCounts = new Map<string, number>();
    let totalTerms = 0;

    for (const rawToken of matches) {
      const token = normalizeToken(rawToken);
      if (token.length < opts.minLen) continue;
      if (stopwords.has(token)) continue;
      if (!isCleanToken(token)) continue;
      if (!termSet.has(token)) continue;
      totalTerms += 1;
      termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
    }

    const lemmaCounts = new Map<string, number>();
    for (const [term, count] of termCounts.entries()) {
      const lemma = tokenToLemma.get(term);
      if (!lemma) continue;
      if (!lemmaSet.has(lemma)) continue;
      lemmaCounts.set(lemma, (lemmaCounts.get(lemma) ?? 0) + count);
    }

    for (const term of termCounts.keys()) {
      termDf.set(term, (termDf.get(term) ?? 0) + 1);
    }
    for (const lemma of lemmaCounts.keys()) {
      lemmaDf.set(lemma, (lemmaDf.get(lemma) ?? 0) + 1);
    }

    lemmaCountsByDoc.set(docId, lemmaCounts);
    docs.push({ docId, termCounts, totalTerms });
  }

  const totalDocs = docs.length;
  const idfByTerm = new Map<string, number>();
  for (const term of terms) {
    idfByTerm.set(term, computeIdf(totalDocs, termDf.get(term) ?? 0));
  }
  const idfByLemma = new Map<string, number>();
  for (const lemma of lemmas) {
    idfByLemma.set(lemma, computeIdf(totalDocs, lemmaDf.get(lemma) ?? 0));
  }

  await mkdir(opts.termsOutDir, { recursive: true });
  await mkdir(opts.lemmasOutDir, { recursive: true });

  for (const doc of docs) {
    const termsOutPath = path.join(opts.termsOutDir, `${doc.docId}.terms.tfidf.txt`);
    const lemmasOutPath = path.join(opts.lemmasOutDir, `${doc.docId}.lemmas.tfidf.txt`);
    const lemmaCounts = lemmaCountsByDoc.get(doc.docId) ?? new Map<string, number>();

    await writeTfidfFile(
      termsOutPath,
      terms,
      doc.totalTerms,
      doc.termCounts,
      idfByTerm
    );
    await writeTfidfFile(
      lemmasOutPath,
      lemmas,
      doc.totalTerms,
      lemmaCounts,
      idfByLemma
    );
  }

  process.stdout.write(
    `Готово. Документов: ${totalDocs}. ` +
      `Файлы: ${opts.termsOutDir}/ и ${opts.lemmasOutDir}/\n`
  );
}

await main();
