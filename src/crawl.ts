import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { URLS } from "../urls.tsx";

type CliOptions = {
  limit: number | "all";
  target: number;
  concurrency: number;
  delayMs: number;
  outDir: string;
  clean: boolean;
  retries: number;
};

function parseArgs(argv: string[]): CliOptions {
  const get = (name: string): string | undefined => {
    const idx = argv.indexOf(`--${name}`);
    if (idx === -1) return undefined;
    return argv[idx + 1];
  };

  const has = (name: string): boolean => argv.includes(`--${name}`);

  const limitRaw = get("limit");
  const limit: number | "all" =
    limitRaw === undefined || limitRaw === "all"
      ? "all"
      : Number(limitRaw);

  if (limit !== "all" && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error(`Некорректный --limit: ${String(limitRaw)}`);
  }

  const target = Number(get("target") ?? "100");
  if (!Number.isFinite(target) || target <= 0) {
    throw new Error(`Некорректный --target: ${String(get("target"))}`);
  }

  const concurrency = Number(get("concurrency") ?? "5");
  if (!Number.isFinite(concurrency) || concurrency <= 0) {
    throw new Error(`Некорректный --concurrency: ${String(get("concurrency"))}`);
  }

  const delayMs = Number(get("delay") ?? "200");
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error(`Некорректный --delay: ${String(get("delay"))}`);
  }

  const retries = Number(get("retries") ?? "3");
  if (!Number.isFinite(retries) || retries < 0) {
    throw new Error(`Некорректный --retries: ${String(get("retries"))}`);
  }

  const outDir = get("outDir") ?? "dump";
  const clean = !has("no-clean");

  return { limit, target, concurrency, delayMs, outDir, clean, retries };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function fetchTextWithRetry(
  url: string,
  retries: number,
  delayMs: number
): Promise<string> {
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: {
          "user-agent":
            "web-search-crawler/1.0 (educational task; +https://example.invalid)",
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          "accept-language": "ru-RU,ru;q=0.9",
          "cache-control": "no-cache"
        }
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("text/html")) {
        throw new Error(`Не text/html (content-type: ${ct || "unknown"})`);
      }

      return await res.text();
    } catch (err) {
      lastErr = err;
      const backoff = Math.min(2000, delayMs * Math.max(1, attempt + 1));
      await sleep(backoff);
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error(`Ошибка скачивания: ${String(lastErr)}`);
}

function padFileNo(n: number) {
  return String(n).padStart(4, "0");
}

async function cleanOutDir(outDir: string) {
  await mkdir(outDir, { recursive: true });
  const entries = await readdir(outDir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (e) => {
      const p = path.join(outDir, e.name);
      await rm(p, { recursive: true, force: true });
    })
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const urls = opts.limit === "all" ? URLS : URLS.slice(0, opts.limit);
  if (urls.length < opts.target) {
    throw new Error(
      `В списке URL меньше требуемого количества (${urls.length} < ${opts.target}). Добавьте ссылки в src/urls.tsx или уменьшите --target`
    );
  }

  const outDir = opts.outDir;
  if (opts.clean) await cleanOutDir(outDir);
  await mkdir(outDir, { recursive: true });

  let nextIndex = 0;
  let written = 0;
  let stop = false;
  const indexLines: string[] = [];
  const failures: Array<{ url: string; error: string }> = [];

  async function worker(workerId: number) {
    while (true) {
      if (stop) return;
      const i = nextIndex++;
      if (i >= urls.length) return;

      const url = urls[i]!;

      try {
        const html = await fetchTextWithRetry(url, opts.retries, opts.delayMs);
        await sleep(opts.delayMs);

        if (stop) return;
        const myNo = ++written;
        const filename = `${padFileNo(myNo)}.txt`;
        const filePath = path.join(outDir, filename);

        await writeFile(filePath, html, "utf8");
        indexLines.push(`${padFileNo(myNo)}\t${url}`);

        if (myNo >= opts.target) {
          stop = true;
          return;
        }

        if (myNo % 10 === 0 || myNo === 1) {
          process.stdout.write(
            `Скачано: ${myNo} / ${opts.target}\n`
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push({ url, error: msg });
        process.stderr.write(
          `[worker ${workerId}] Пропуск: ${url} (${msg})\n`
        );
      }
    }
  }

  const workers = Array.from({ length: opts.concurrency }, (_, idx) =>
    worker(idx + 1)
  );
  await Promise.all(workers);

  if (written < opts.target) {
    const details =
      failures.length > 0
        ? `\nОшибок: ${failures.length}. Примеры:\n- ${failures
            .slice(0, 10)
            .map((f) => `${f.url} (${f.error})`)
            .join("\n- ")}\n`
        : "\n";
    throw new Error(
      `Не удалось скачать минимум ${opts.target} страниц. Успешно: ${written}.${details}`
    );
  }

  const indexPath = path.join(process.cwd(), "index.txt");
  indexLines.sort();
  await writeFile(indexPath, indexLines.join("\n") + "\n", "utf8");

  process.stdout.write(
    `Готово. Файлов: ${written}. Папка: ${outDir}. index.txt создан.\n`
  );
}

await main();