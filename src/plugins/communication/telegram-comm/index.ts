import type { CommunicationAdapter } from "../../../adapters/index.js";
import { TelegramCommPlugin } from "./telegram-comm.js";

export function createPlugin(): CommunicationAdapter {
  return new TelegramCommPlugin();
}
