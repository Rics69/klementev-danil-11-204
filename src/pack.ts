import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import archiver from "archiver";

async function main() {
  const outZip = path.join(process.cwd(), "submission.zip");
  const dumpDir = path.join(process.cwd(), "dump");
  const indexFile = path.join(process.cwd(), "index.txt");

  await stat(dumpDir);
  await stat(indexFile);

  const output = createWriteStream(outZip);
  const archive = archiver("zip", { zlib: { level: 9 } });

  const done = new Promise<void>((resolve, reject) => {
    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("warning", (err) => {
      process.stderr.write(String(err) + "\n");
    });
    archive.on("error", reject);
  });

  archive.pipe(output);
  archive.file(indexFile, { name: "index.txt" });
  archive.directory(dumpDir, "dump");
  await archive.finalize();
  await done;

  process.stdout.write(`Создан архив: ${outZip}\n`);
}

await main();