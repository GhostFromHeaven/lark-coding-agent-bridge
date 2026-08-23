import { readFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import type { KnownChat } from './lark-info';

interface ChatRegistryEntry {
  id: string;
  name: string;
  /** Set for entries added via {@link ChatRegistryStore.upsertP2p} — kept across listChats refreshes. */
  p2p?: true;
}

interface ChatRegistryData {
  updatedAt: number;
  chats: ChatRegistryEntry[];
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
              (c): c is ChatRegistryEntry =>
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

  /** Replace the whole snapshot (listChats is authoritative for group chats; p2p entries survive). */
  replaceAll(chats: KnownChat[], updatedAt: number = Date.now()): void {
    const refreshed = chats.map((c) => ({ id: c.id, name: c.name }));
    const refreshedIds = new Set(refreshed.map((c) => c.id));
    // listChats never returns p2p chats — keep upserted p2p entries so the
    // registry stays a complete id→name mirror for external readers.
    const p2pEntries = this.data.chats.filter((c) => c.p2p && !refreshedIds.has(c.id));
    this.data = { updatedAt, chats: [...refreshed, ...p2pEntries] };
    this.schedulePersist();
  }

  /** Add or update a p2p chat entry (id → the peer user's display name). */
  upsertP2p(id: string, name: string): void {
    const existing = this.data.chats.find((c) => c.id === id);
    if (existing) {
      existing.name = name;
      existing.p2p = true;
    } else {
      this.data.chats.push({ id, name, p2p: true });
    }
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
