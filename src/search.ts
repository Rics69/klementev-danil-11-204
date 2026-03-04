import { createInterface } from "node:readline/promises";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

type CliOptions = {
  lemmasDir: string;
  query?: string;
};

type TokenKind = "TERM" | "AND" | "OR" | "NOT" | "LPAREN" | "RPAREN";

type QueryToken = {
  kind: TokenKind;
  value: string;
};

const TERM_RE = /[\p{L}\p{N}_-]+/u;

function parseArgs(argv: string[]): CliOptions {
  const get = (name: string): string | undefined => {
    const idx = argv.indexOf(`--${name}`);
    if (idx === -1) return undefined;
    return argv[idx + 1];
  };

  return {
    lemmasDir: get("lemmasDir") ?? "lemmas_by_doc",
    query: get("query")
  };
}

function getDocIdFromFilename(filename: string): string | null {
  const m = filename.match(/^(\d+)\.lemmas\.txt$/);
  return m ? m[1] : null;
}

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

async function buildInvertedIndex(lemmasDir: string): Promise<{
  index: Map<string, Set<string>>;
  allDocs: Set<string>;
}> {
  const entries = await readdir(lemmasDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".lemmas.txt"))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, "ru-RU"));

  if (files.length === 0) {
    throw new Error(`В папке ${lemmasDir} нет файлов *.lemmas.txt`);
  }

  const index = new Map<string, Set<string>>();
  const allDocs = new Set<string>();

  for (const file of files) {
    const docId = getDocIdFromFilename(file);
    if (!docId) continue;

    allDocs.add(docId);
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

  return { index, allDocs };
}

function tokenizeQuery(input: string): QueryToken[] {
  const out: QueryToken[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === "(") {
      out.push({ kind: "LPAREN", value: ch });
      i += 1;
      continue;
    }

    if (ch === ")") {
      out.push({ kind: "RPAREN", value: ch });
      i += 1;
      continue;
    }

    const rest = input.slice(i);
    const m = rest.match(TERM_RE);
    if (!m || m.index !== 0) {
      throw new Error(`Некорректный символ в запросе: "${ch}"`);
    }

    const raw = m[0];
    const upper = raw.toUpperCase();
    if (upper === "AND") {
      out.push({ kind: "AND", value: "AND" });
    } else if (upper === "OR") {
      out.push({ kind: "OR", value: "OR" });
    } else if (upper === "NOT") {
      out.push({ kind: "NOT", value: "NOT" });
    } else {
      out.push({ kind: "TERM", value: normalizeToken(raw) });
    }

    i += raw.length;
  }

  if (out.length === 0) {
    throw new Error("Пустой запрос");
  }

  return out;
}

function precedence(kind: TokenKind): number {
  if (kind === "NOT") return 3;
  if (kind === "AND") return 2;
  if (kind === "OR") return 1;
  return 0;
}

function isOperator(kind: TokenKind): boolean {
  return kind === "NOT" || kind === "AND" || kind === "OR";
}

function toPostfix(tokens: QueryToken[]): QueryToken[] {
  const output: QueryToken[] = [];
  const ops: QueryToken[] = [];

  for (const tok of tokens) {
    if (tok.kind === "TERM") {
      output.push(tok);
      continue;
    }

    if (isOperator(tok.kind)) {
      while (ops.length > 0) {
        const top = ops[ops.length - 1]!;
        if (!isOperator(top.kind)) break;

        const topPrec = precedence(top.kind);
        const curPrec = precedence(tok.kind);
        const rightAssoc = tok.kind === "NOT";
        const shouldPop = rightAssoc ? topPrec > curPrec : topPrec >= curPrec;
        if (!shouldPop) break;

        output.push(ops.pop()!);
      }
      ops.push(tok);
      continue;
    }

    if (tok.kind === "LPAREN") {
      ops.push(tok);
      continue;
    }

    if (tok.kind === "RPAREN") {
      let foundLparen = false;
      while (ops.length > 0) {
        const top = ops.pop()!;
        if (top.kind === "LPAREN") {
          foundLparen = true;
          break;
        }
        output.push(top);
      }
      if (!foundLparen) {
        throw new Error("Несогласованные скобки в запросе");
      }
    }
  }

  while (ops.length > 0) {
    const top = ops.pop()!;
    if (top.kind === "LPAREN" || top.kind === "RPAREN") {
      throw new Error("Несогласованные скобки в запросе");
    }
    output.push(top);
  }

  return output;
}

function setUnion(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>(a);
  for (const x of b) out.add(x);
  return out;
}

function setIntersection(a: Set<string>, b: Set<string>): Set<string> {
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  const out = new Set<string>();
  for (const x of small) {
    if (big.has(x)) out.add(x);
  }
  return out;
}

function setDifference(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const x of a) {
    if (!b.has(x)) out.add(x);
  }
  return out;
}

function evaluatePostfix(
  postfix: QueryToken[],
  termDocs: Map<string, Set<string>>,
  allDocs: Set<string>
): Set<string> {
  const st: Set<string>[] = [];

  for (const tok of postfix) {
    if (tok.kind === "TERM") {
      st.push(new Set(termDocs.get(tok.value) ?? []));
      continue;
    }

    if (tok.kind === "NOT") {
      const a = st.pop();
      if (!a) throw new Error("Некорректный запрос: NOT без операнда");
      st.push(setDifference(allDocs, a));
      continue;
    }

    if (tok.kind === "AND" || tok.kind === "OR") {
      const b = st.pop();
      const a = st.pop();
      if (!a || !b) {
        throw new Error(`Некорректный запрос: ${tok.kind} без двух операндов`);
      }

      st.push(tok.kind === "AND" ? setIntersection(a, b) : setUnion(a, b));
    }
  }

  if (st.length !== 1) {
    throw new Error("Некорректный запрос: не удалось вычислить выражение");
  }

  return st[0]!;
}

async function normalizeQueryTerms(tokens: QueryToken[]): Promise<QueryToken[]> {
  const rawTerms = tokens.filter((t) => t.kind === "TERM").map((t) => t.value);
  const uniqueTerms = Array.from(new Set(rawTerms));
  const ruTerms = uniqueTerms.filter(isLikelyRussian);
  const ruLemmaMap = await lemmatizeRussianTokens(ruTerms);

  return tokens.map((tok) => {
    if (tok.kind !== "TERM") return tok;
    if (!isLikelyRussian(tok.value)) return tok;
    return { ...tok, value: ruLemmaMap.get(tok.value) ?? tok.value };
  });
}

async function getQueryFromUser(): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    return (await rl.question("Введите булев запрос: ")).trim();
  } finally {
    rl.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { index, allDocs } = await buildInvertedIndex(opts.lemmasDir);

  const queryRaw = (opts.query ?? (await getQueryFromUser())).trim();
  if (!queryRaw) {
    throw new Error("Запрос пустой");
  }

  const rawTokens = tokenizeQuery(queryRaw);
  const normalizedTokens = await normalizeQueryTerms(rawTokens);
  const postfix = toPostfix(normalizedTokens);
  const result = evaluatePostfix(postfix, index, allDocs);
  const docs = Array.from(result).sort((a, b) => a.localeCompare(b, "ru-RU"));

  process.stdout.write(`Найдено документов: ${docs.length}\n`);
  for (const doc of docs) {
    process.stdout.write(`${doc}\n`);
  }
}

await main();
