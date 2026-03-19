import http from "node:http";
import { URL } from "node:url";
import {
  loadVectorSearchIndex,
  searchByVector,
  type SearchResult,
  type VectorSearchIndex
} from "./vector_search_core";

type CliOptions = {
  port: number;
  host: string;
  tfidfDir: string;
  indexFile: string;
};

function parseArgs(argv: string[]): CliOptions {
  const get = (name: string): string | undefined => {
    const idx = argv.indexOf(`--${name}`);
    if (idx === -1) return undefined;
    return argv[idx + 1];
  };

  const portRaw = get("port") ?? "3000";
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Некорректный --port: ${portRaw}`);
  }

  return {
    port,
    host: get("host") ?? "127.0.0.1",
    tfidfDir: get("tfidfDir") ?? "tfidf_lemmas_by_doc",
    indexFile: get("indexFile") ?? "index.txt"
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return `
      <div class="empty">
        <p>Совпадений нет. Попробуйте изменить запрос.</p>
      </div>
    `;
  }

  const items = results
    .map((result, index) => {
      const safeUrl = result.url ? escapeHtml(result.url) : "";
      const safeDocId = escapeHtml(result.docId);
      const score = result.score.toFixed(8);
      const title = safeUrl || `Документ ${safeDocId}`;

      return `
        <li class="result-card">
          <div class="result-rank">${index + 1}</div>
          <div class="result-body">
            <a class="result-title" href="${safeUrl}" target="_blank" rel="noreferrer">
              ${title}
            </a>
            <div class="result-meta">
              <span>Doc ID: ${safeDocId}</span>
              <span>Score: ${score}</span>
            </div>
          </div>
        </li>
      `;
    })
    .join("");

  return `<ol class="results">${items}</ol>`;
}

function renderPage(query: string, results: SearchResult[], error?: string): string {
  const safeQuery = escapeHtml(query);
  const safeError = error ? escapeHtml(error) : "";
  const resultCount = results.length;
  const content = query
    ? renderResults(results)
    : `
      <div class="empty">
        <p>Введите запрос, чтобы увидеть 10 наиболее релевантных документов.</p>
      </div>
    `;

  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Vector Search</title>
    <style>
      :root {
        --bg: #f2ede3;
        --paper: rgba(255, 251, 244, 0.9);
        --text: #1f1a17;
        --muted: #6b6259;
        --accent: #b44f2d;
        --accent-2: #204e5a;
        --border: rgba(31, 26, 23, 0.12);
        --shadow: 0 24px 60px rgba(69, 43, 28, 0.12);
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: Georgia, "Times New Roman", serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(180, 79, 45, 0.22), transparent 32%),
          radial-gradient(circle at top right, rgba(32, 78, 90, 0.18), transparent 26%),
          linear-gradient(160deg, #efe5d6 0%, #f6f1e7 45%, #e8dfd0 100%);
      }

      .shell {
        width: min(980px, calc(100vw - 32px));
        margin: 32px auto;
        padding: 28px;
        border: 1px solid var(--border);
        border-radius: 28px;
        background: var(--paper);
        box-shadow: var(--shadow);
        backdrop-filter: blur(12px);
      }

      .hero {
        display: grid;
        gap: 14px;
        margin-bottom: 28px;
      }

      .eyebrow {
        margin: 0;
        color: var(--accent);
        text-transform: uppercase;
        letter-spacing: 0.18em;
        font-size: 12px;
      }

      h1 {
        margin: 0;
        font-size: clamp(34px, 6vw, 72px);
        line-height: 0.95;
        font-weight: 700;
      }

      .lead {
        margin: 0;
        max-width: 720px;
        color: var(--muted);
        font-size: 18px;
        line-height: 1.6;
      }

      form {
        display: grid;
        gap: 12px;
        grid-template-columns: 1fr auto;
        margin-bottom: 16px;
      }

      input[type="search"] {
        width: 100%;
        padding: 18px 20px;
        border-radius: 18px;
        border: 1px solid var(--border);
        font-size: 18px;
        background: rgba(255, 255, 255, 0.72);
        color: var(--text);
      }

      button {
        padding: 18px 24px;
        border: 0;
        border-radius: 18px;
        font-size: 16px;
        font-weight: 700;
        color: #fff9f4;
        background: linear-gradient(135deg, var(--accent), #d4774c);
        cursor: pointer;
      }

      .summary {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        margin: 12px 0 24px;
        color: var(--muted);
        font-size: 15px;
      }

      .error {
        margin: 0 0 16px;
        padding: 14px 16px;
        border-radius: 16px;
        background: rgba(180, 79, 45, 0.12);
        color: #8e3518;
      }

      .results {
        margin: 0;
        padding: 0;
        list-style: none;
        display: grid;
        gap: 14px;
      }

      .result-card {
        display: grid;
        grid-template-columns: 56px 1fr;
        gap: 16px;
        align-items: start;
        padding: 18px;
        border-radius: 22px;
        background: rgba(255, 255, 255, 0.74);
        border: 1px solid rgba(32, 78, 90, 0.08);
      }

      .result-rank {
        display: grid;
        place-items: center;
        width: 56px;
        height: 56px;
        border-radius: 18px;
        color: white;
        font-size: 20px;
        font-weight: 700;
        background: linear-gradient(135deg, var(--accent-2), #2e7183);
      }

      .result-body {
        display: grid;
        gap: 8px;
      }

      .result-title {
        color: var(--text);
        text-decoration: none;
        font-size: 22px;
        line-height: 1.3;
        word-break: break-word;
      }

      .result-title:hover {
        color: var(--accent);
      }

      .result-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        color: var(--muted);
        font-size: 14px;
      }

      .empty {
        padding: 28px;
        border-radius: 24px;
        border: 1px dashed var(--border);
        color: var(--muted);
        background: rgba(255, 255, 255, 0.44);
      }

      @media (max-width: 720px) {
        .shell {
          width: min(100vw - 20px, 100%);
          margin: 10px auto;
          padding: 18px;
          border-radius: 24px;
        }

        form {
          grid-template-columns: 1fr;
        }

        button,
        input[type="search"] {
          width: 100%;
        }

        .summary {
          flex-direction: column;
          align-items: flex-start;
        }

        .result-card {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="hero">
        <h1>Поиск по TF-IDF векторной модели</h1>
        <p class="lead">
          Введите запрос, система лемматизирует его, сравнит с векторами документов и
          покажет 10 самых релевантных результатов.
        </p>
      </section>

      <form method="get" action="/">
        <input
          type="search"
          name="q"
          value="${safeQuery}"
          placeholder="Например: казань университет история"
          autocomplete="off"
        >
        <button type="submit">Найти</button>
      </form>

      ${error ? `<p class="error">${safeError}</p>` : ""}

      <div class="summary">
        <span>Топ-10 результатов</span>
        <span>${query ? `Найдено: ${resultCount}` : "Ожидание запроса"}</span>
      </div>

      ${content}
    </main>
  </body>
</html>`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const index = await loadVectorSearchIndex(opts.tfidfDir, opts.indexFile);

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (requestUrl.pathname !== "/") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }

      const query = (requestUrl.searchParams.get("q") ?? "").trim();
      let results: SearchResult[] = [];
      let error: string | undefined;

      if (query) {
        try {
          results = await searchByVector(index, query, 10);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
      }

      const html = renderPage(query, results, error);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Internal server error: ${message}`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });

  process.stdout.write(
    `Веб-интерфейс запущен: http://${opts.host}:${String(opts.port)}\n`
  );
}

await main();
