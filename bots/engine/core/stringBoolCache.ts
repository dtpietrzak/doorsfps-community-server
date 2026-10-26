/** Parallel-array string→bool memo. ScriptC 0.0.35 `Map` is not safe on think. */

export type StringBoolCache = {
  keys: string[];
  values: boolean[];
  count: number;
};

export function createStringBoolCache(): StringBoolCache {
  return { keys: [], values: [], count: 0 };
}

export function clearStringBoolCache(cache: StringBoolCache): void {
  cache.count = 0;
}

/** 0 = miss, 1 = stored false, 2 = stored true. */
export function getStringBool(cache: StringBoolCache, key: string): number {
  const keys = cache.keys;
  const n = cache.count;
  for (let i = 0; i < n; i++) {
    if (keys[i] === key) return cache.values[i] === true ? 2 : 1;
  }
  return 0;
}

export function setStringBool(
  cache: StringBoolCache,
  key: string,
  value: boolean,
): void {
  const keys = cache.keys;
  const values = cache.values;
  const n = cache.count;
  for (let i = 0; i < n; i++) {
    if (keys[i] === key) {
      values[i] = value;
      return;
    }
  }
  if (n < keys.length) {
    keys[n] = key;
    values[n] = value;
  } else {
    keys.push(key);
    values.push(value);
  }
  cache.count = n + 1;
}
