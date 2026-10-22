import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fallbackFileName,
  mediaFailureNotice,
  resolveMediaMaxBytes,
  resolveUploadTimeoutMs,
  shouldSendAsImage,
  CaptionSender,
} from "./media-policy.ts";

test("картинкой уходят только форматы, которые Мессенджер показывает инлайн", () => {
  assert.equal(shouldSendAsImage("image/png"), true);
  assert.equal(shouldSendAsImage("image/jpeg; charset=binary"), true);
  assert.equal(shouldSendAsImage("image/svg+xml"), false);
  assert.equal(shouldSendAsImage("application/pdf"), false);
  assert.equal(shouldSendAsImage(undefined), false);
  assert.equal(shouldSendAsImage("image/png", true), false);
});

test("имя файла: из пути или URL, для URL без пути — по расширению", () => {
  assert.equal(fallbackFileName("/data/.openclaw/workspace/report.xlsx"), "report.xlsx");
  assert.equal(fallbackFileName("report.pdf"), "report.pdf");
  assert.equal(fallbackFileName("https://x.ru/a/%D0%BE%D1%82%D1%87%D1%91%D1%82.pdf?t=1"), "отчёт.pdf");
  assert.equal(fallbackFileName("https://x.ru", "png"), "file.png");
  assert.equal(fallbackFileName("https://x.ru/", ".txt"), "file.txt");
});

test("уведомление об ошибке не раскрывает путь и параметры URL", () => {
  assert.equal(mediaFailureNotice("/etc/passwd"), "Не получилось отправить файл «passwd».");
  const notice = mediaFailureNotice("https://cdn.example.com/private/report.pdf?token=SECRET");
  assert.equal(notice, "Не получилось отправить файл «report.pdf».");
  assert.ok(!notice.includes("SECRET") && !notice.includes("cdn.example.com"));
  assert.equal(
    mediaFailureNotice("https://cdn.example.com/%2Fdata%2Fsecret"),
    "Не получилось отправить файл «secret».",
  );
  assert.equal(
    mediaFailureNotice("https://cdn.example.com/a%5Cb%5Cc.txt"),
    "Не получилось отправить файл «c.txt».",
  );
});

test("лимиты: размер по умолчанию 50 МБ, таймаут загрузки растёт с размером", () => {
  assert.equal(resolveMediaMaxBytes(undefined), 50 * 1024 * 1024);
  assert.equal(resolveMediaMaxBytes(0), 50 * 1024 * 1024);
  assert.equal(resolveMediaMaxBytes(10), 10 * 1024 * 1024);
  assert.equal(resolveUploadTimeoutMs(1024), 120_000);
  assert.equal(resolveUploadTimeoutMs(50 * 1024 * 1024), 200_000);
});

test("подпись: при сбое на второй части досылается только остаток, без дублей", async () => {
  const delivered: string[] = [];
  let calls = 0;
  const sender = new CaptionSender(["часть 1", "часть 2", "часть 3"], async (chunk) => {
    calls += 1;
    if (calls === 2) throw new Error("network");
    delivered.push(chunk);
  });
  await assert.rejects(() => sender.sendAll());
  assert.deepEqual(delivered, ["часть 1"]);
  assert.equal(sender.remainingText(), "часть 2\nчасть 3");
});

test("подпись: после полной отправки остатка нет, пустая подпись не отправляется", async () => {
  const delivered: string[] = [];
  const sender = new CaptionSender(["a", "b"], async (chunk) => {
    delivered.push(chunk);
  });
  await sender.sendAll();
  assert.deepEqual(delivered, ["a", "b"]);
  assert.equal(sender.remainingText(), "");
  assert.equal(new CaptionSender(["", "  "], async () => {}).isEmpty, true);
});
