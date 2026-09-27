import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

/** Per-scope entry. `cwd` is absent for model-only entries (scope set a model
 *  via `/model` before any `/cd` binding); falls through to the profile
 *  default cwd in that case. */
interface ChatEntry {
  cwd?: string;
  model?: string;
}

/** Named alias entry. Legacy configs stored a bare cwd string; new writes use
 *  the object form so a model can ride along. Both read paths normalize. */
type NamedEntry = string | { cwd: string; model?: string };

interface WorkspaceData {
  chats: Record<string, ChatEntry>;
  named: Record<string, NamedEntry>;
}

export class WorkspaceStore {
  private data: WorkspaceData = { chats: {}, named: {} };
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string = paths.workspacesFile) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(text) as Partial<WorkspaceData>;
      this.data = {
        chats: parsed.chats ?? {},
        named: parsed.named ?? {},
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  cwdFor(chatId: string): string | undefined {
    return this.data.chats[chatId]?.cwd;
  }

  setCwd(chatId: string, cwd: string): void {
    this.data.chats[chatId] = { ...this.data.chats[chatId], cwd };
    this.schedulePersist();
  }

  modelFor(chatId: string): string | undefined {
    return this.data.chats[chatId]?.model;
  }

  /** Set (or clear with null) the scope-level model override. Survives `/cd`
   *  switches; an entry left with neither cwd nor model is removed. */
  setModel(chatId: string, model: string | null): void {
    const prev = this.data.chats[chatId] ?? {};
    const next: ChatEntry = model === null ? { ...prev, model: undefined } : { ...prev, model };
    if (next.cwd === undefined && next.model === undefined) {
      delete this.data.chats[chatId];
    } else {
      this.data.chats[chatId] = next;
    }
    this.schedulePersist();
  }

  removeCwd(chatId: string): boolean {
    if (!(chatId in this.data.chats)) return false;
    delete this.data.chats[chatId];
    this.schedulePersist();
    return true;
  }

  listCwds(prefix?: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.data.chats)) {
      if (value.cwd === undefined) continue;
      if (prefix && !key.startsWith(prefix)) continue;
      out[key] = value.cwd;
    }
    return out;
  }

  listNamed(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.data.named)) {
      const cwd = this.namedCwd(value);
      if (cwd !== undefined) out[key] = cwd;
    }
    return out;
  }

  getNamed(name: string): string | undefined {
    return this.namedCwd(this.data.named[name]);
  }

  namedModelFor(name: string): string | undefined {
    return typeof this.data.named[name] === 'object' ? this.data.named[name].model : undefined;
  }

  saveNamed(name: string, cwd: string): void {
    const prev = this.data.named[name];
    const prevModel = typeof prev === 'object' ? prev.model : undefined;
    this.data.named[name] = prevModel ? { cwd, model: prevModel } : { cwd };
    this.schedulePersist();
  }

  /** Set (or clear with null) the model on an existing named alias.
   *  Returns false when the alias does not exist. */
  setNamedModel(name: string, model: string | null): boolean {
    if (!(name in this.data.named)) return false;
    const cwd = this.namedCwd(this.data.named[name]) ?? '';
    this.data.named[name] = model === null ? { cwd } : { cwd, model };
    this.schedulePersist();
    return true;
  }

  /** Reverse lookup: the model of the first named alias whose cwd resolves to
   *  `cwdRealpath`. Aliases without a model are skipped so "first match with
   *  a model" wins regardless of insertion order of bare-cwd aliases. */
  namedModelForCwd(cwdRealpath: string): string | undefined {
    for (const entry of Object.values(this.data.named)) {
      const model = typeof entry === 'object' ? entry.model : undefined;
      if (!model) continue;
      const cwd = this.namedCwd(entry) ?? '';
      let resolved = cwd;
      try {
        resolved = realpathSync(cwd);
      } catch {
        // missing dir etc. — fall back to raw comparison
      }
      if (resolved === cwdRealpath) return model;
    }
    return undefined;
  }

  removeNamed(name: string): boolean {
    if (!(name in this.data.named)) return false;
    delete this.data.named[name];
    this.schedulePersist();
    return true;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private namedCwd(entry: NamedEntry | undefined): string | undefined {
    if (entry === undefined) return undefined;
    return typeof entry === 'string' ? entry : entry.cwd;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`, {
          mode: 0o600,
        });
      })
      .catch((err: unknown) => {
        log.fail('workspace', err, { step: 'persist' });
      });
  }
}
