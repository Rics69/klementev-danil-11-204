import { createInterface } from "node:readline/promises";
import {
  loadVectorSearchIndex,
  searchByVector
} from "./vector_search_core";

type CliOptions = {
  tfidfDir: string;
  indexFile: string;
  query?: string;
  top: number;
};

function parseArgs(argv: string[]): CliOptions {
  const get = (name: string): string | undefined => {
    const idx = argv.indexOf(`--${name}`);
    if (idx === -1) return undefined;
    return argv[idx + 1];
  };

  const topRaw = get("top") ?? "10";
  const top = Number(topRaw);
  if (!Number.isFinite(top) || top <= 0) {
    throw new Error(`Некорректный --top: ${topRaw}`);
  }

  return {
    tfidfDir: get("tfidfDir") ?? "tfidf_lemmas_by_doc",
    indexFile: get("indexFile") ?? "index.txt",
    query: get("query"),
    top
  };
}

async function getQueryFromUser(): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    return (await rl.question("Введите поисковый запрос: ")).trim();
  } finally {
    rl.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const queryRaw = (opts.query ?? (await getQueryFromUser())).trim();
  if (!queryRaw) {
    throw new Error("Запрос пустой");
  }

  const index = await loadVectorSearchIndex(opts.tfidfDir, opts.indexFile);
  const results = await searchByVector(index, queryRaw, opts.top);

  if (results.length === 0) {
    process.stdout.write("Нет совпадений: термины запроса отсутствуют в индексе.\n");
    return;
  }

  process.stdout.write(`Найдено документов: ${results.length}\n`);
  for (const result of results) {
    const score = result.score.toFixed(8);
    const urlPart = result.url ? ` ${result.url}` : "";
    process.stdout.write(`${result.docId} ${score}${urlPart}\n`);
  }
}

await main();
