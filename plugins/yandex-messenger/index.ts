import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { yandexMessengerPlugin } from "./src/channel.js";
import { setYandexRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "yandex-messenger",
  name: "Yandex Messenger",
  description: "Канал Яндекс Мессенджера (Яндекс 360): группы, треды, личка по белому списку",
  plugin: yandexMessengerPlugin,
  setRuntime: setYandexRuntime,
});
