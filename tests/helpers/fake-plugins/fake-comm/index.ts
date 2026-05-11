import { CommunicationAdapter } from "../../../../src/adapters/communication.js";
import type {
  FormattedMessage,
  HealthStatus,
  InitResult,
  MessageType,
  SendResult,
  Target,
} from "../../../../src/schemas/adapters.js";

interface SentMessage {
  target: Target;
  message: FormattedMessage;
}

/**
 * Fake communication plugin for testing.
 *
 * Test control surface:
 * - `getMessages()` — all messages sent through this plugin
 * - `clearMessages()` — reset the message log
 * - `setUnhealthy(fail)` — make healthCheck return unhealthy
 * - `getInitConfig()` — what config was passed to initialize
 * - `wasShutdownCalled()` — whether shutdown was called
 */
export class FakeCommunicationPlugin extends CommunicationAdapter {
  private sentMessages: SentMessage[] = [];
  private shouldFailHealthCheck = false;
  private initConfig: Record<string, unknown> | null = null;
  private shutdownCalled = false;

  // ── Test Control Surface ────────────────────────────────────────────────

  getMessages(): SentMessage[] {
    return [...this.sentMessages];
  }

  clearMessages(): void {
    this.sentMessages = [];
  }

  setUnhealthy(fail: boolean): void {
    this.shouldFailHealthCheck = fail;
  }

  getInitConfig(): Record<string, unknown> | null {
    return this.initConfig;
  }

  wasShutdownCalled(): boolean {
    return this.shutdownCalled;
  }

  // ── Adapter Implementation ──────────────────────────────────────────────

  protected doSendMessage(target: Target, message: FormattedMessage): Promise<SendResult> {
    this.sentMessages.push({ target, message });
    return Promise.resolve({
      success: true,
      message_id: `fake-msg-${String(this.sentMessages.length)}`,
      error: null,
    });
  }

  formatMessage(content: string, _type: MessageType): string {
    return content;
  }

  protected doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    this.initConfig = config;
    if (config["_force_fail"] === true) {
      return Promise.resolve({ success: false, message: "Forced failure for testing" });
    }
    return Promise.resolve({ success: true, message: null });
  }

  protected doShutdown(): Promise<void> {
    this.shutdownCalled = true;
    return Promise.resolve();
  }

  protected doHealthCheck(): Promise<HealthStatus> {
    return Promise.resolve({
      healthy: !this.shouldFailHealthCheck,
      message: this.shouldFailHealthCheck ? "Fake comm unhealthy" : null,
      details: null,
    });
  }
}

export function createPlugin(): CommunicationAdapter {
  return new FakeCommunicationPlugin();
}
