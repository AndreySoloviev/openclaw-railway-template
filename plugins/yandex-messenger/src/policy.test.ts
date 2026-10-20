import assert from "node:assert/strict";
import { test } from "node:test";
import type { YandexBotInfo, YandexMessage } from "./api.ts";
import {
  buildAgentBody,
  DenyRateLimiter,
  formatDmDenyText,
  isGroupChatId,
  normalizeTarget,
  resolveMentionFacts,
  resolveThreadRoot,
  splitThreadTarget,
  toRecipient,
} from "./policy.ts";

const bot: YandexBotInfo = {
  id: "343e6904-5d15-9214-679d-d0c405de59c5",
  login: "yndx-mssngr-UPayS7XIaG-bot",
  display_name: "Леонид",
};
const andrey = {
  id: "31c0c9d3-c0a7-4f32-9e0f-29cc35a86c94",
  login: "solovievandrey",
  display_name: "Андрей С.",
  robot: false,
};
const groupId = "0/0/81685715-e4f2-42a0-8eb7-868518dfdcc8";

function groupMessage(extra: Partial<YandexMessage>): YandexMessage {
  return {
    update_id: 1,
    message_id: 1792488505030016,
    timestamp: 1792488505,
    chat: { type: "group", id: groupId },
    from: andrey,
    text: "",
    ...extra,
  };
}

test("явное упоминание бота распознаётся по mentioned_users", () => {
  const facts = resolveMentionFacts(
    groupMessage({ text: `@${bot.login}`, mentioned_users: [{ ...bot, robot: true }] }),
    bot,
  );
  assert.deepEqual(facts, { explicit: true, replyToBot: false, hasAnyMention: true });
});

test("сообщение без упоминания не считается обращением", () => {
  const facts = resolveMentionFacts(groupMessage({ text: "Сообщение без упоминания" }), bot);
  assert.deepEqual(facts, { explicit: false, replyToBot: false, hasAnyMention: false });
});

test("упоминание другого человека не считается упоминанием бота", () => {
  const facts = resolveMentionFacts(
    groupMessage({ text: "@petrov глянь", mentioned_users: [{ id: "other", login: "petrov" }] }),
    bot,
  );
  assert.equal(facts.explicit, false);
  assert.equal(facts.hasAnyMention, true);
});

test("ответ на сообщение бота — неявное упоминание", () => {
  const facts = resolveMentionFacts(
    groupMessage({ reply_to_message: { message_id: 5, from: { ...bot, robot: true }, text: "x" } }),
    bot,
  );
  assert.equal(facts.replyToBot, true);
});

test("в общем чате корень треда — само сообщение, в треде — его thread_id", () => {
  assert.equal(resolveThreadRoot(groupMessage({})), 1792488505030016);
  assert.equal(
    resolveThreadRoot(
      groupMessage({
        message_id: 1792489534651016,
        chat: { type: "group", id: groupId, thread_id: 1792488505030016 },
      }),
    ),
    1792488505030016,
  );
  assert.equal(
    resolveThreadRoot({ ...groupMessage({}), chat: { type: "private", id: "a_b" } }),
    undefined,
  );
});

test("логин бота в тексте заменяется именем, цитата добавляется контекстом", () => {
  const body = buildAgentBody(
    groupMessage({
      text: `прочитай это @${bot.login}`,
      reply_to_message: { message_id: 1, from: andrey, text: "Сообщение без упоминания" },
    }),
    bot,
  );
  assert.equal(
    body,
    "[в ответ на сообщение Андрей С.: «Сообщение без упоминания»]\nпрочитай это @Леонид",
  );
});

test("адресаты: группа, тред, личный чат, логин", () => {
  assert.equal(normalizeTarget("yandex-messenger:solovievandrey"), "solovievandrey");
  assert.equal(normalizeTarget("ym: " + groupId), groupId);
  assert.equal(isGroupChatId(groupId), true);
  assert.deepEqual(splitThreadTarget(`${groupId}#1792488505030016`), {
    chatId: groupId,
    threadId: 1792488505030016,
  });
  assert.deepEqual(splitThreadTarget(groupId), { chatId: groupId });
  assert.deepEqual(splitThreadTarget(`${groupId}#abc`), { chatId: `${groupId}#abc` });
  assert.deepEqual(toRecipient(groupId), { chat_id: groupId });
  assert.deepEqual(toRecipient(`${andrey.id}_${bot.id}`), { chat_id: `${andrey.id}_${bot.id}` });
  assert.deepEqual(toRecipient("solovievandrey"), { login: "solovievandrey" });
});

test("текст отказа подставляет имя собеседника", () => {
  assert.equal(
    formatDmDenyText(undefined, "Мария"),
    "Извини, Мария, со мной напрямую может общаться только Андрей.",
  );
  assert.equal(formatDmDenyText("Нет, {name}", undefined), "Нет, коллега");
});

test("отказ одному человеку — не чаще раза в интервал", () => {
  const limiter = new DenyRateLimiter(1000);
  assert.equal(limiter.shouldSend("u1", 0), true);
  assert.equal(limiter.shouldSend("u1", 500), false);
  assert.equal(limiter.shouldSend("u2", 500), true);
  assert.equal(limiter.shouldSend("u1", 1500), true);
});
