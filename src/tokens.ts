import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { decode } from "html-entities";
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

async function lemmatizeRussianTokens(tokens: string[]): Promise<Map<string, string>> {
  if (tokens.length === 0) return new Map();

  return new Promise<Map<string, string>>((resolve, reject) => {
    const scriptPath = path.join(process.cwd(), "src", "lemmatize_ru.py");
    const child = spawn("python3", [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Ошибка лемматизации (python exit ${String(code)}): ${stderr.trim()}`
          )
        );
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as Record<string, string>;
        resolve(new Map(Object.entries(parsed)));
      } catch (err) {
        reject(
          err instanceof Error
            ? err
            : new Error(`Некорректный JSON от лемматизатора: ${String(err)}`)
        );
      }
    });

    child.stdin.write(JSON.stringify(tokens));
    child.stdin.end();
  });
}

function buildLemmaLines(
  tokens: string[],
  lemmaByToken: Map<string, string>,
  collator: Intl.Collator
): string[] {
  const lemmaToTokens = new Map<string, Set<string>>();
  for (const token of tokens) {
    const lemma = lemmaByToken.get(token) ?? token;
    if (!lemma) continue;

    if (!lemmaToTokens.has(lemma)) {
      lemmaToTokens.set(lemma, new Set<string>());
    }
    lemmaToTokens.get(lemma)!.add(token);
  }

  return Array.from(lemmaToTokens.entries())
    .sort((a, b) => collator.compare(a[0], b[0]))
    .map(([lemma, groupedTokens]) => {
      const sortedTokens = Array.from(groupedTokens).sort(collator.compare);
      return `${lemma} ${sortedTokens.join(" ")}`;
    });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const stopwords = buildStopwordSet();
  const collator = new Intl.Collator("ru-RU");

  const entries = await readdir(opts.inDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".txt"))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, "ru-RU"));

  if (files.length === 0) {
    throw new Error(`В папке ${opts.inDir} нет .txt файлов`);
  }

  const tokenSet = new Set<string>();
  const tokensByFile = new Map<string, string[]>();
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

    const fileTokens = Array.from(fileTokenSet).sort(collator.compare);
    tokensByFile.set(file, fileTokens);
    const stem = path.parse(file).name;
    const fileTokensOut = path.join(opts.perFileTokensDir, `${stem}.tokens.txt`);
    await writeFile(fileTokensOut, fileTokens.join("\n") + "\n", "utf8");
  }

  const tokens = Array.from(tokenSet).sort(collator.compare);
  const ruTokens = tokens.filter(isLikelyRussian);
  const ruLemmaMap = await lemmatizeRussianTokens(ruTokens);
  const lemmaByToken = new Map<string, string>();

  for (const token of tokens) {
    if (isLikelyRussian(token)) {
      lemmaByToken.set(token, ruLemmaMap.get(token) ?? token);
      continue;
    }
    lemmaByToken.set(token, token);
  }

  const lemmaLines = buildLemmaLines(tokens, lemmaByToken, collator);
  for (const [file, fileTokens] of tokensByFile.entries()) {
    const stem = path.parse(file).name;
    const fileLemmasOut = path.join(opts.perFileLemmasDir, `${stem}.lemmas.txt`);
    const fileLemmaLines = buildLemmaLines(fileTokens, lemmaByToken, collator);
    await writeFile(fileLemmasOut, fileLemmaLines.join("\n") + "\n", "utf8");
  }

  await writeFile(opts.tokensOut, tokens.join("\n") + "\n", "utf8");
  await writeFile(opts.lemmasOut, lemmaLines.join("\n") + "\n", "utf8");

  process.stdout.write(
    `Готово. Токенов: ${tokens.length}. Лемм: ${lemmaLines.length}.\n` +
      `Файлы: ${opts.tokensOut}, ${opts.lemmasOut}\n`
  );
}

await main();
