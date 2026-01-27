/**
 * File Token Storage Provider for Node.js
 * Stores tokens as individual JSON files
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TokenStorageProvider, TxfStorageDataBase, SyncResult, SaveResult, LoadResult } from '../../../storage';
import type { FullIdentity, ProviderStatus } from '../../../types';

export interface FileTokenStorageConfig {
  /** Directory to store token files */
  tokensDir: string;
}

export class FileTokenStorageProvider implements TokenStorageProvider<TxfStorageDataBase> {
  readonly id = 'file-token-storage';
  readonly name = 'File Token Storage';
  readonly type = 'local' as const;

  private tokensDir: string;
  private status: ProviderStatus = 'disconnected';
  private identity: FullIdentity | null = null;

  constructor(config: FileTokenStorageConfig | string) {
    this.tokensDir = typeof config === 'string' ? config : config.tokensDir;
  }

  setIdentity(identity: FullIdentity): void {
    this.identity = identity;
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
        address: this.identity?.address ?? '',
        formatVersion: '2.0',
        updatedAt: Date.now(),
      },
    };

    try {
      const files = fs.readdirSync(this.tokensDir).filter(f => f.endsWith('.json') && f !== '_meta.json');

      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(this.tokensDir, file), 'utf-8');
          const token = JSON.parse(content);
          const key = `_${path.basename(file, '.json')}` as `_${string}`;
          data[key] = token;
        } catch {
          // Skip invalid files
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
        path.join(this.tokensDir, '_meta.json'),
        JSON.stringify(data._meta, null, 2)
      );

      // Save each token
      for (const [key, value] of Object.entries(data)) {
        if (key.startsWith('_') && key !== '_meta' && key !== '_tombstones' && key !== '_outbox' && key !== '_sent' && key !== '_invalid') {
          const tokenId = key.slice(1);
          fs.writeFileSync(
            path.join(this.tokensDir, `${tokenId}.json`),
            JSON.stringify(value, null, 2)
          );
        }
      }

      // Handle tombstones - delete files
      if (data._tombstones) {
        for (const tombstone of data._tombstones) {
          const filePath = path.join(this.tokensDir, `${tombstone.tokenId}.json`);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        }
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

  async deleteToken(tokenId: string): Promise<void> {
    const filePath = path.join(this.tokensDir, `${tokenId}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  async saveToken(tokenId: string, tokenData: unknown): Promise<void> {
    fs.writeFileSync(
      path.join(this.tokensDir, `${tokenId}.json`),
      JSON.stringify(tokenData, null, 2)
    );
  }

  async getToken(tokenId: string): Promise<unknown | null> {
    const filePath = path.join(this.tokensDir, `${tokenId}.json`);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async listTokenIds(): Promise<string[]> {
    const files = fs.readdirSync(this.tokensDir).filter(f => f.endsWith('.json') && f !== '_meta.json');
    return files.map(f => path.basename(f, '.json'));
  }
}

export function createFileTokenStorageProvider(config: FileTokenStorageConfig | string): FileTokenStorageProvider {
  return new FileTokenStorageProvider(config);
}
