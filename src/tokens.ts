import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { decode } from "html-entities";
import snowball from "snowball-stemmers";
import stopword from "stopword";

type CliOptions = {
  inDir: string;
  tokensOut: string;
  lemmasOut: string;
  perFileTokensDir: string;
  perFileLemmasDir: string;
  minLen: number;
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

  const inDir = get("inDir") ?? "dump";
  const tokensOut = get("tokensOut") ?? "tokens.txt";
  const lemmasOut = get("lemmasOut") ?? "lemmas.txt";
  const perFileTokensDir = get("perFileTokensDir") ?? "tokens_by_doc";
  const perFileLemmasDir = get("perFileLemmasDir") ?? "lemmas_by_doc";
  const minLenRaw = get("minLen") ?? "2";
  const minLen = Number(minLenRaw);

  if (!Number.isFinite(minLen) || minLen < 1) {
    throw new Error(`Некорректный --minLen: ${minLenRaw}`);
  }

  return {
    inDir,
    tokensOut,
    lemmasOut,
    perFileTokensDir,
    perFileLemmasDir,
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

function isLikelyRussian(token: string): boolean {
  return /[а-яё]/i.test(token);
}

function isCleanToken(token: string): boolean {
  if (!/^[a-zа-яё-]+$/i.test(token)) return false;
  if (!/^[a-zа-яё]+(?:-[a-zа-яё]+)*$/i.test(token)) return false;

  const hasCyr = /[а-яё]/i.test(token);
  const hasLat = /[a-z]/i.test(token);
  if (hasCyr && hasLat) return false;

  return hasCyr || hasLat;
}

function lemmatizeToken(
  token: string,
  ruStemmer: { stem: (word: string) => string },
  enStemmer: { stem: (word: string) => string }
): string {
  if (isLikelyRussian(token)) return ruStemmer.stem(token);
  return enStemmer.stem(token);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const stopwords = buildStopwordSet();

  const { newStemmer } = snowball as {
    newStemmer: (algo: string) => { stem: (word: string) => string };
  };
  const ruStemmer = newStemmer("russian");
  const enStemmer = newStemmer("english");

  const entries = await readdir(opts.inDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".txt"))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, "ru-RU"));

  if (files.length === 0) {
    throw new Error(`В папке ${opts.inDir} нет .txt файлов`);
  }

  const tokenSet = new Set<string>();
  await mkdir(opts.perFileTokensDir, { recursive: true });
  await mkdir(opts.perFileLemmasDir, { recursive: true });

  for (const file of files) {
    const p = path.join(opts.inDir, file);
    const html = await readFile(p, "utf8");
    const text = sanitizeHtml(html);
    const matches = text.match(TOKEN_RE) ?? [];
    const fileTokenSet = new Set<string>();

    for (const rawToken of matches) {
      const token = normalizeToken(rawToken);
      if (token.length < opts.minLen) continue;
      if (stopwords.has(token)) continue;
      if (!isCleanToken(token)) continue;
      tokenSet.add(token);
      fileTokenSet.add(token);
    }

    const collator = new Intl.Collator("ru-RU");
    const fileTokens = Array.from(fileTokenSet).sort(collator.compare);
    const fileLemmaToTokens = new Map<string, Set<string>>();

    for (const token of fileTokens) {
      const lemma = lemmatizeToken(token, ruStemmer, enStemmer);
      if (!lemma || lemma.length < opts.minLen) continue;
      if (!fileLemmaToTokens.has(lemma)) {
        fileLemmaToTokens.set(lemma, new Set<string>());
      }
      fileLemmaToTokens.get(lemma)!.add(token);
    }

    const fileLemmaLines = Array.from(fileLemmaToTokens.entries())
      .sort((a, b) => collator.compare(a[0], b[0]))
      .map(([lemma, groupedTokens]) => {
        const sortedTokens = Array.from(groupedTokens).sort(collator.compare);
        return `${lemma} ${sortedTokens.join(" ")}`;
      });

    const stem = path.parse(file).name;
    const fileTokensOut = path.join(opts.perFileTokensDir, `${stem}.tokens.txt`);
    const fileLemmasOut = path.join(opts.perFileLemmasDir, `${stem}.lemmas.txt`);

    await writeFile(fileTokensOut, fileTokens.join("\n") + "\n", "utf8");
    await writeFile(fileLemmasOut, fileLemmaLines.join("\n") + "\n", "utf8");
  }

  const collator = new Intl.Collator("ru-RU");
  const tokens = Array.from(tokenSet).sort(collator.compare);

  const lemmaToTokens = new Map<string, Set<string>>();
  for (const token of tokens) {
    const lemma = lemmatizeToken(token, ruStemmer, enStemmer);
    if (!lemma || lemma.length < opts.minLen) continue;

    if (!lemmaToTokens.has(lemma)) {
      lemmaToTokens.set(lemma, new Set<string>());
    }
    lemmaToTokens.get(lemma)!.add(token);
  }

  const lemmaLines = Array.from(lemmaToTokens.entries())
    .sort((a, b) => collator.compare(a[0], b[0]))
    .map(([lemma, groupedTokens]) => {
      const sortedTokens = Array.from(groupedTokens).sort(collator.compare);
      return `${lemma} ${sortedTokens.join(" ")}`;
    });

  await writeFile(opts.tokensOut, tokens.join("\n") + "\n", "utf8");
  await writeFile(opts.lemmasOut, lemmaLines.join("\n") + "\n", "utf8");

  process.stdout.write(
    `Готово. Токенов: ${tokens.length}. Лемм: ${lemmaLines.length}.\n` +
      `Файлы: ${opts.tokensOut}, ${opts.lemmasOut}\n`
  );
}

await main();
