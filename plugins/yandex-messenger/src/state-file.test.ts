import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PluginStateFile } from "./state-file.ts";

test("состояние переживает перезапуск: offset и треды бота", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ym-state-")), "default.json");
  const first = new PluginStateFile(path);
  await first.load();
  await first.setOffset(42);
  await first.addBotThread("g#1");
  const second = new PluginStateFile(path);
  await second.load();
  assert.equal(second.offset, 42);
  assert.equal(second.hasBotThread("g#1"), true);
  assert.equal(second.hasBotThread("g#2"), false);
});

test("offset не откатывается назад", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ym-state-")), "default.json");
  const state = new PluginStateFile(path);
  await state.load();
  await state.setOffset(10);
  await state.setOffset(5);
  assert.equal(JSON.parse(await readFile(path, "utf8")).offset, 10);
});

test("битый файл не роняет канал, а стартует с пустого состояния", async () => {
  for (const content of ["{not json", "null", ""]) {
    const path = join(await mkdtemp(join(tmpdir(), "ym-state-")), "default.json");
    await writeFile(path, content);
    const state = new PluginStateFile(path);
    await state.load();
    assert.equal(state.offset, 0);
    assert.ok(state.loadError);
  }
});
