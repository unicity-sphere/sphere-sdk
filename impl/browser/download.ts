/**
 * Browser Download Utilities
 * Functions for downloading wallet backups as files
 */

import type { Sphere } from '../../core/Sphere';
import type { WalletJSON, WalletJSONExportOptions } from '../../types';

// =============================================================================
// Types
// =============================================================================

export interface DownloadTextOptions {
  /** Password for encryption */
  password?: string;
  /** Number of addresses to include */
  addressCount?: number;
  /** Custom filename (without extension) */
  filename?: string;
}

export interface DownloadJSONOptions extends WalletJSONExportOptions {
  /** Custom filename (without extension) */
  filename?: string;
  /** Pretty print JSON (default: true) */
  pretty?: boolean;
}

// =============================================================================
// Core Download Function
// =============================================================================

/**
 * Download content as a file in the browser
 */
export function downloadFile(
  content: string | Blob,
  filename: string,
  mimeType: string = 'text/plain'
): void {
  const blob = content instanceof Blob
    ? content
    : new Blob([content], { type: mimeType });

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  link.click();

  // Clean up the URL after a short delay
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

/**
 * Download text content as a .txt file
 */
export function downloadTextFile(content: string, filename: string): void {
  downloadFile(content, filename, 'text/plain');
}

/**
 * Download JSON content as a .json file
 */
export function downloadJSONFile(content: object | string, filename: string): void {
  const jsonString = typeof content === 'string'
    ? content
    : JSON.stringify(content, null, 2);
  downloadFile(jsonString, filename, 'application/json');
}

// =============================================================================
// Wallet Download Functions
// =============================================================================

/**
 * Download wallet backup as text file
 *
 * @example
 * ```ts
 * // Download unencrypted backup
 * downloadWalletText(sphere);
 *
 * // Download encrypted backup
 * downloadWalletText(sphere, { password: 'secret' });
 *
 * // Custom filename
 * downloadWalletText(sphere, { filename: 'my-backup' });
 * ```
 */
export function downloadWalletText(sphere: Sphere, options: DownloadTextOptions = {}): void {
  const content = sphere.exportToTxt({
    password: options.password,
    addressCount: options.addressCount,
  });

  const filename = options.filename
    ? `${options.filename}.txt`
    : `sphere-wallet-${Date.now()}.txt`;

  downloadTextFile(content, filename);
}

/**
 * Download wallet backup as JSON file
 *
 * @example
 * ```ts
 * // Download unencrypted backup
 * downloadWalletJSON(sphere);
 *
 * // Download encrypted backup
 * downloadWalletJSON(sphere, { password: 'secret' });
 *
 * // Include multiple addresses
 * downloadWalletJSON(sphere, { addressCount: 5 });
 * ```
 */
export function downloadWalletJSON(sphere: Sphere, options: DownloadJSONOptions = {}): void {
  const json = sphere.exportToJSON({
    password: options.password,
    addressCount: options.addressCount,
    includeMnemonic: options.includeMnemonic,
  });

  const filename = options.filename
    ? `${options.filename}.json`
    : `sphere-wallet-${Date.now()}.json`;

  const jsonString = options.pretty !== false
    ? JSON.stringify(json, null, 2)
    : JSON.stringify(json);

  downloadFile(jsonString, filename, 'application/json');
}

/**
 * Download pre-built WalletJSON as file
 */
export function downloadWalletJSONData(json: WalletJSON, filename?: string): void {
  const name = filename || `sphere-wallet-${Date.now()}.json`;
  downloadJSONFile(json, name.endsWith('.json') ? name : `${name}.json`);
}

// =============================================================================
// File Reading Utilities
// =============================================================================

/**
 * Read a file as text
 */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

/**
 * Read a file as ArrayBuffer (for binary files like .dat)
 */
export function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Read a file as Uint8Array (for binary files like .dat)
 */
export async function readFileAsUint8Array(file: File): Promise<Uint8Array> {
  const buffer = await readFileAsArrayBuffer(file);
  return new Uint8Array(buffer);
}
