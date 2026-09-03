/**
 * Identity state that must not split when tsup bundles each subpath export separately
 * (`splitting: false`) or when ESM and CJS both load: globalThis, VERSIONED key,
 * validated on read, never key material. Why: tests/unit/core/global-cell.test.ts.
 */
const CELLS_KEY = '__sphere_sdk_cells_v1__';

type CellBag = Record<string, unknown>;

/** Set only when globalThis refuses the bag; cells then degrade to this bundle. */
let bundleLocalBag: CellBag | null = null;

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function installBag(host: CellBag, fresh: CellBag): boolean {
  try {
    Object.defineProperty(host, CELLS_KEY, {
      value: fresh,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    return host[CELLS_KEY] === fresh;
  } catch {
    return false;
  }
}

function cellBag(): CellBag {
  if (bundleLocalBag) return bundleLocalBag;
  const host = globalThis as unknown as CellBag;
  const found = host[CELLS_KEY];
  if (isObject(found)) return found as CellBag;
  const fresh: CellBag = {};
  if (!installBag(host, fresh)) bundleLocalBag = fresh;
  return fresh;
}

function accepted(intact: (candidate: object) => boolean, candidate: object): boolean {
  try {
    return intact(candidate);
  } catch {
    return false;
  }
}

function put(bag: CellBag, name: string, cell: object): void {
  try {
    bag[name] = cell;
    if (bag[name] === cell) return;
  } catch { /* a frozen or trapped bag — this bundle keeps its cells locally */ }
  if (bag !== bundleLocalBag) bundleLocalBag = { [name]: cell };
}

/** The cell `name` (suffix its shape version, `@1`), created once and shared by every
 *  bundle; `intact` rejects a foreign value rather than adopting it as SDK state. */
export function sharedCell<T extends object>(
  name: string,
  create: () => T,
  intact: (candidate: object) => boolean,
): T {
  const bag = cellBag();
  const found = bag[name];
  if (isObject(found) && accepted(intact, found)) return found as T;
  const fresh = create();
  put(bag, name, fresh);
  return fresh;
}
