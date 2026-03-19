import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export type SearchResult = {
  docId: string;
  score: number;
  url?: string;
};

type DocumentVectors = {
  vectors: Map<string, Map<string, number>>;
  norms: Map<string, number>;
  idfByLemma: Map<string, number>;
};

export type VectorSearchIndex = {
  docVectors: Map<string, Map<string, number>>;
  docNorms: Map<string, number>;
  idfByLemma: Map<string, number>;
  urlByDocId: Map<string, string>;
};

const QUERY_TOKEN_RE = /\p{L}+(?:-\p{L}+)*/gu;

function normalizeToken(token: string): string {
  return token.toLocaleLowerCase("ru-RU");
}

function isLikelyRussian(token: string): boolean {
  return /[а-яё]/i.test(token);
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

function tokenizeQuery(query: string): string[] {
  const tokens = query.match(QUERY_TOKEN_RE) ?? [];
  return tokens.map(normalizeToken).filter(Boolean);
}

export async function normalizeQueryToLemmas(query: string): Promise<string[]> {
  const rawTokens = tokenizeQuery(query);
  if (rawTokens.length === 0) {
    throw new Error("Запрос пустой");
  }

  const uniqueRuTokens = Array.from(new Set(rawTokens.filter(isLikelyRussian)));
  const lemmaByToken = await lemmatizeRussianTokens(uniqueRuTokens);

  return rawTokens.map((token) => {
    if (!isLikelyRussian(token)) return token;
    return lemmaByToken.get(token) ?? token;
  });
}

async function loadUrls(indexFile: string): Promise<Map<string, string>> {
  const raw = await readFile(indexFile, "utf8");
  const urlByDocId = new Map<string, string>();

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [docId, url] = trimmed.split("\t");
    if (!docId || !url) continue;
    urlByDocId.set(docId, url);
  }

  return urlByDocId;
}

async function loadDocumentVectors(tfidfDir: string): Promise<DocumentVectors> {
  const entries = await readdir(tfidfDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".lemmas.tfidf.txt"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "ru-RU"));

  if (files.length === 0) {
    throw new Error(`В папке ${tfidfDir} нет файлов *.lemmas.tfidf.txt`);
  }

  const vectors = new Map<string, Map<string, number>>();
  const norms = new Map<string, number>();
  const idfByLemma = new Map<string, number>();

  for (const file of files) {
    const docId = file.replace(/\.lemmas\.tfidf\.txt$/, "");
    const raw = await readFile(path.join(tfidfDir, file), "utf8");
    const vector = new Map<string, number>();
    let sumSquares = 0;

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const parts = trimmed.split(/\s+/);
      const lemma = parts[0];
      const idf = Number(parts[1]);
      const weight = Number(parts[2]);
      if (!lemma || !Number.isFinite(idf) || !Number.isFinite(weight)) continue;

      if (!idfByLemma.has(lemma)) {
        idfByLemma.set(lemma, idf);
      }

      if (weight === 0) continue;
      vector.set(lemma, weight);
      sumSquares += weight * weight;
    }

    vectors.set(docId, vector);
    norms.set(docId, Math.sqrt(sumSquares));
  }

  return { vectors, norms, idfByLemma };
}

function buildQueryVector(
  lemmas: string[],
  idfByLemma: Map<string, number>
): { vector: Map<string, number>; norm: number } {
  const counts = new Map<string, number>();
  for (const lemma of lemmas) {
    if (!idfByLemma.has(lemma)) continue;
    counts.set(lemma, (counts.get(lemma) ?? 0) + 1);
  }

  const totalTerms = Array.from(counts.values()).reduce((sum, count) => sum + count, 0);
  if (totalTerms === 0) {
    return { vector: new Map(), norm: 0 };
  }

  const vector = new Map<string, number>();
  let sumSquares = 0;

  for (const [lemma, count] of counts.entries()) {
    const tf = count / totalTerms;
    const idf = idfByLemma.get(lemma) ?? 0;
    const weight = tf * idf;
    if (weight === 0) continue;
    vector.set(lemma, weight);
    sumSquares += weight * weight;
  }

  return { vector, norm: Math.sqrt(sumSquares) };
}

function cosineSimilarity(
  queryVector: Map<string, number>,
  queryNorm: number,
  docVector: Map<string, number>,
  docNorm: number
): number {
  if (queryNorm === 0 || docNorm === 0) return 0;

  let dot = 0;
  for (const [lemma, queryWeight] of queryVector.entries()) {
    const docWeight = docVector.get(lemma);
    if (docWeight === undefined) continue;
    dot += queryWeight * docWeight;
  }

  if (dot === 0) return 0;
  return dot / (queryNorm * docNorm);
}

function rankDocuments(
  queryVector: Map<string, number>,
  queryNorm: number,
  docVectors: Map<string, Map<string, number>>,
  docNorms: Map<string, number>,
  urlByDocId: Map<string, string>,
  top: number
): SearchResult[] {
  const results: SearchResult[] = [];

  for (const [docId, docVector] of docVectors.entries()) {
    const score = cosineSimilarity(
      queryVector,
      queryNorm,
      docVector,
      docNorms.get(docId) ?? 0
    );
    if (score <= 0) continue;
    results.push({
      docId,
      score,
      url: urlByDocId.get(docId)
    });
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.docId.localeCompare(b.docId, "ru-RU");
  });

  return results.slice(0, top);
}

export async function loadVectorSearchIndex(
  tfidfDir: string,
  indexFile: string
): Promise<VectorSearchIndex> {
  const [urlByDocId, docData] = await Promise.all([
    loadUrls(indexFile),
    loadDocumentVectors(tfidfDir)
  ]);

  return {
    docVectors: docData.vectors,
    docNorms: docData.norms,
    idfByLemma: docData.idfByLemma,
    urlByDocId
  };
}

export async function searchByVector(
  index: VectorSearchIndex,
  queryRaw: string,
  top: number
): Promise<SearchResult[]> {
  const queryLemmas = await normalizeQueryToLemmas(queryRaw);
  const { vector: queryVector, norm: queryNorm } = buildQueryVector(
    queryLemmas,
    index.idfByLemma
  );

  if (queryVector.size === 0 || queryNorm === 0) {
    return [];
  }

  return rankDocuments(
    queryVector,
    queryNorm,
    index.docVectors,
    index.docNorms,
    index.urlByDocId,
    top
  );
}
