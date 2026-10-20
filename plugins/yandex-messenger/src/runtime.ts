import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setYandexRuntime, getRuntime: getYandexRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "yandex-messenger",
    errorMessage: "Yandex Messenger runtime not initialized",
  });
export { getYandexRuntime, setYandexRuntime };
