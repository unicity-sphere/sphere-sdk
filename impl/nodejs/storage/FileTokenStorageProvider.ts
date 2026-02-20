/**
 * File Token Storage Provider for Node.js
 * Stores tokens as individual JSON files in per-address subdirectories
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TokenStorageProvider, TxfStorageDataBase, SyncResult, SaveResult, LoadResult, HistoryRecord } from '../../../storage';
import type { FullIdentity, ProviderStatus } from '../../../types';
import { getAddressId } from '../../../constants';

const META_FILE = '_meta.json';
const TOMBSTONES_FILE = '_tombstones.json';
const HISTORY_FILE = '_history.json';

export interface FileTokenStorageConfig {
  /** Directory to store token files */
  tokensDir: string;
}

export class FileTokenStorageProvider implements TokenStorageProvider<TxfStorageDataBase> {
  readonly id = 'file-token-storage';
  readonly name = 'File Token Storage';
  readonly type = 'local' as const;

  private baseTokensDir: string;
  private status: ProviderStatus = 'disconnected';
  private identity: FullIdentity | null = null;

  constructor(config: FileTokenStorageConfig | string) {
    this.baseTokensDir = typeof config === 'string' ? config : config.tokensDir;
  }

  setIdentity(identity: FullIdentity): void {
    this.identity = identity;
  }

  /**
   * Get tokens directory for current address
   * Format: {baseTokensDir}/{addressId}/
   */
  private get tokensDir(): string {
    if (this.identity?.directAddress) {
      // getAddressId returns sanitized format: DIRECT_abc123_xyz789
      const addressId = getAddressId(this.identity.directAddress);
      return path.join(this.baseTokensDir, addressId);
    }
    return this.baseTokensDir;
  }

  async initialize(): Promise<boolean> {
    if (!fs.existsSync(this.tokensDir)) {
      fs.mkdirSync(this.tokensDir, { recursive: true });
    }
    this.status = 'connected';
    return true;
  }

  async shutdown(): Promise<void> {
    this.status = 'disconnected';
  }

  async connect(): Promise<void> {
    await this.initialize();
  }

  async disconnect(): Promise<void> {
    this.status = 'disconnected';
  }

  isConnected(): boolean {
    return this.status === 'connected';
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  async load(): Promise<LoadResult<TxfStorageDataBase>> {
    const data: TxfStorageDataBase = {
      _meta: {
        version: 1,
        address: this.identity?.l1Address ?? '',
        formatVersion: '2.0',
        updatedAt: Date.now(),
      },
    };

    try {
      const files = fs.readdirSync(this.tokensDir).filter(f =>
        f.endsWith('.json') &&
        f !== META_FILE &&
        f !== TOMBSTONES_FILE &&
        f !== HISTORY_FILE &&
        !f.startsWith('archived_') &&  // Skip archived tokens
        !f.startsWith('token-') &&     // Skip legacy token format
        !f.startsWith('nametag-')      // Skip nametag files (not tokens)
      );

      for (const file of files) {
        try {
          const basename = path.basename(file, '.json');
          // Skip file-format entries (token-, nametag-) - they are loaded via loadTokensFromFileStorage
          if (basename.startsWith('token-') || basename.startsWith('nametag-')) {
            continue;
          }

          const content = fs.readFileSync(path.join(this.tokensDir, file), 'utf-8');
          const token = JSON.parse(content);

          if (basename.startsWith('archived-')) {
            // Archived tokens: keep as-is (archived-tokenId key)
            data[basename as keyof TxfStorageDataBase] = token;
          } else {
            // Other entries: add _ prefix for TXF format
            const key = `_${basename}` as `_${string}`;
            data[key] = token;
          }
        } catch {
          // Skip invalid files
        }
      }

      // Load tombstones if they exist
      const tombstonesPath = path.join(this.tokensDir, TOMBSTONES_FILE);
      if (fs.existsSync(tombstonesPath)) {
        try {
          const content = fs.readFileSync(tombstonesPath, 'utf-8');
          data._tombstones = JSON.parse(content);
        } catch {
          // Skip invalid tombstones file
        }
      }

      return {
        success: true,
        data,
        source: 'local',
        timestamp: Date.now(),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        source: 'local',
        timestamp: Date.now(),
      };
    }
  }

  async save(data: TxfStorageDataBase): Promise<SaveResult> {
    try {
      // Save meta
      fs.writeFileSync(
        path.join(this.tokensDir, META_FILE),
        JSON.stringify(data._meta, null, 2)
      );

      // Save each token (active tokens start with _, archived with archived-)
      const reservedKeys = ['_meta', '_tombstones', '_outbox', '_sent', '_invalid'];
      for (const [key, value] of Object.entries(data)) {
        if (reservedKeys.includes(key)) continue;

        if (key.startsWith('_')) {
          // Active token: _tokenId -> tokenId.json
          const tokenId = key.slice(1);
          fs.writeFileSync(
            path.join(this.tokensDir, `${tokenId}.json`),
            JSON.stringify(value, null, 2)
          );
        } else if (key.startsWith('archived-')) {
          // Archived token: archived-tokenId -> archived-tokenId.json (keep prefix)
          fs.writeFileSync(
            path.join(this.tokensDir, `${key}.json`),
            JSON.stringify(value, null, 2)
          );
        }
      }

      // Handle tombstones - delete files AND persist tombstones list
      if (data._tombstones) {
        // Delete tombstoned token files
        for (const tombstone of data._tombstones) {
          const filePath = path.join(this.tokensDir, `${tombstone.tokenId}.json`);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        }
        // Persist tombstones list so they can be checked on reload
        fs.writeFileSync(
          path.join(this.tokensDir, TOMBSTONES_FILE),
          JSON.stringify(data._tombstones, null, 2)
        );
      }

      return {
        success: true,
        timestamp: Date.now(),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now(),
      };
    }
  }

  async sync(localData: TxfStorageDataBase): Promise<SyncResult<TxfStorageDataBase>> {
    // For file storage, just save and return
    const saveResult = await this.save(localData);
    return {
      success: saveResult.success,
      merged: localData,
      added: 0,
      removed: 0,
      conflicts: 0,
      error: saveResult.error,
    };
  }

  async clear(): Promise<boolean> {
    try {
      if (!fs.existsSync(this.tokensDir)) {
        return true;
      }
      const files = fs.readdirSync(this.tokensDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        fs.unlinkSync(path.join(this.tokensDir, file));
      }
      return true;
    } catch {
      return false;
    }
  }

  // =========================================================================
  // History operations
  // =========================================================================

  private get historyPath(): string {
    return path.join(this.tokensDir, HISTORY_FILE);
  }

  private readHistoryFile(): Record<string, HistoryRecord> {
    try {
      if (fs.existsSync(this.historyPath)) {
        return JSON.parse(fs.readFileSync(this.historyPath, 'utf-8'));
      }
    } catch {
      // Ignore corrupt file
    }
    return {};
  }

  private writeHistoryFile(data: Record<string, HistoryRecord>): void {
    fs.writeFileSync(this.historyPath, JSON.stringify(data, null, 2));
  }

  async addHistoryEntry(entry: HistoryRecord): Promise<void> {
    const data = this.readHistoryFile();
    data[entry.dedupKey] = entry;
    this.writeHistoryFile(data);
  }

  async getHistoryEntries(): Promise<HistoryRecord[]> {
    const data = this.readHistoryFile();
    return Object.values(data).sort((a, b) => b.timestamp - a.timestamp);
  }

  async hasHistoryEntry(dedupKey: string): Promise<boolean> {
    const data = this.readHistoryFile();
    return dedupKey in data;
  }

  async clearHistory(): Promise<void> {
    try {
      if (fs.existsSync(this.historyPath)) {
        fs.unlinkSync(this.historyPath);
      }
    } catch {
      // Ignore
    }
  }

  async importHistoryEntries(entries: HistoryRecord[]): Promise<number> {
    if (entries.length === 0) return 0;
    const data = this.readHistoryFile();
    let imported = 0;
    for (const entry of entries) {
      if (!(entry.dedupKey in data)) {
        data[entry.dedupKey] = entry;
        imported++;
      }
    }
    if (imported > 0) {
      this.writeHistoryFile(data);
    }
    return imported;
  }

}

export function createFileTokenStorageProvider(config: FileTokenStorageConfig | string): FileTokenStorageProvider {
  return new FileTokenStorageProvider(config);
}
