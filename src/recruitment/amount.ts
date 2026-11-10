const MAX_SAFE_AMOUNT = Number.MAX_SAFE_INTEGER;

export function parseAmount(input: string, allowUnset = true): number | undefined {
    if (typeof input !== 'string') throw new Error('Amount must be text.');
    const value = input.trim().toLowerCase();
    if (allowUnset && ['', 'none', 'unset', 'off', 'null'].includes(value)) return undefined;

    const match = value.replaceAll(',', '').match(/^(\d+(?:\.\d+)?)([kmbt])?$/i);
    if (!match) {
        throw new Error('Enter a non-negative number, optionally using K, M, B or T.');
    }
    const base = Number(match[1]);
    const multiplier = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[match[2] as 'k' | 'm' | 'b' | 't'] ?? 1;
    const amount = base * multiplier;
    if (!Number.isFinite(amount) || amount < 0 || amount > MAX_SAFE_AMOUNT) {
        throw new Error('Amount must be a finite safe number at least 0.');
    }
    return amount;
}

export function formatAmount(amount: number | undefined): string {
    return amount === undefined ? 'Not set' : amount.toLocaleString('en-GB');
}
