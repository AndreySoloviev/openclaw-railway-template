import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { yandexMessengerPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(yandexMessengerPlugin);
