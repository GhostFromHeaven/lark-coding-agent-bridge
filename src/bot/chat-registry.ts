import { readFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import type { KnownChat } from './lark-info';

interface ChatRegistryData {
  updatedAt: number;
  chats: KnownChat[];
}

/**
 * Best-effort on-disk mirror of the bot's known chats (`im/v1/chats` list),
 * so other readers (e.g. the admin dashboard) can resolve chat display names
 * without calling the Feishu API. Derived data: re-fetched every 30 minutes,
 * so a missing or corrupt file simply starts empty.
 */
export class ChatRegistryStore {
  private data: ChatRegistryData = { updatedAt: 0, chats: [] };
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** Best-effort load; missing or corrupt file → empty (start fresh). */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    try {
      const parsed = JSON.parse(text) as Partial<ChatRegistryData>;
      this.data = {
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
        chats: Array.isArray(parsed.chats)
          ? parsed.chats.filter(
              (c): c is KnownChat =>
                !!c && typeof c === 'object' && typeof c.id === 'string' && typeof c.name === 'string',
            )
          : [],
      };
    } catch {
      this.data = { updatedAt: 0, chats: [] };
    }
  }

  nameFor(chatId: string): string | undefined {
    return this.data.chats.find((c) => c.id === chatId)?.name;
  }

  /** Replace the whole snapshot (listChats is authoritative). */
  replaceAll(chats: KnownChat[], updatedAt: number = Date.now()): void {
    this.data = { updatedAt, chats: chats.map((c) => ({ id: c.id, name: c.name })) };
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`, {
          mode: 0o600,
        });
      })
      .catch((err: unknown) => {
        log.fail('chat-registry', err, { step: 'persist' });
      });
  }
}
