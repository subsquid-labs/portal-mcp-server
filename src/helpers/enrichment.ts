/**
 * Value Enrichment Helpers
 *
 * Converts hex values to human-readable amounts using token decimals.
 * Solves: "Every transfer returns raw value: '0x2386f26fc10000'"
 */

interface TokenInfo {
  symbol?: string;
  decimals?: number;
  name?: string;
}

/**
 * Convert hex value to human-readable decimal string
 */
export function hexToDecimal(hex: string, decimals: number = 18): string {
  if (!hex || hex === "0x" || hex === "0x0") {
    return "0";
  }

  // Remove 0x prefix
  const hexValue = hex.startsWith("0x") ? hex.slice(2) : hex;

  // Convert to BigInt
  let value: bigint;
  try {
    value = BigInt("0x" + hexValue);
  } catch {
    return hex; // Return original if conversion fails
  }

  if (decimals === 0) {
    return value.toString();
  }

  // Split into integer and decimal parts
  const divisor = BigInt(10 ** decimals);
  const integerPart = value / divisor;
  const remainder = value % divisor;

  if (remainder === BigInt(0)) {
    return integerPart.toString();
  }

  // Format decimal part with leading zeros
  const decimalPart = remainder.toString().padStart(decimals, "0");
  // Trim trailing zeros
  const trimmed = decimalPart.replace(/0+$/, "");

  return trimmed ? `${integerPart}.${trimmed}` : integerPart.toString();
}

/**
 * Format value with token symbol (e.g., "1000.5 USDC")
 */
export function formatTokenAmount(hex: string, tokenInfo?: TokenInfo): string {
  if (!tokenInfo) {
    return hex; // Return raw if no token info
  }

  const decimals = tokenInfo.decimals ?? 18;
  const amount = hexToDecimal(hex, decimals);
  const symbol = tokenInfo.symbol || "tokens";

  return `${amount} ${symbol}`;
}

/**
 * Enrich transfer object with human-readable amount
 */
export function enrichTransfer(transfer: any, tokenInfo?: TokenInfo): any {
  if (!transfer.value) {
    return transfer;
  }

  return {
    ...transfer,
    value_raw: transfer.value, // Keep original
    value_formatted: formatTokenAmount(transfer.value, tokenInfo),
    value_decimal: hexToDecimal(transfer.value, tokenInfo?.decimals),
  };
}

/**
 * Enrich array of transfers
 */
export function enrichTransfers(transfers: any[], tokenInfoMap?: Map<string, TokenInfo>): any[] {
  if (!tokenInfoMap) {
    return transfers;
  }

  return transfers.map(transfer => {
    const tokenAddr = transfer.address?.toLowerCase();
    const tokenInfo = tokenAddr ? tokenInfoMap.get(tokenAddr) : undefined;
    return enrichTransfer(transfer, tokenInfo);
  });
}

/**
 * Fetch token info from Portal API
 */
export async function fetchTokenInfo(dataset: string, addresses: string[]): Promise<Map<string, TokenInfo>> {
  const tokenMap = new Map<string, TokenInfo>();

  // TODO: Implement actual Portal API call to get token metadata
  // For now, return common tokens for testing
  const commonTokens: Record<string, TokenInfo> = {
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6, name: "USD Coin" },
    "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18, name: "Wrapped Ether" },
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { symbol: "WETH", decimals: 18, name: "Wrapped Ether" },
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6, name: "USD Coin" },
    "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT", decimals: 6, name: "Tether USD" },
    "0x6b175474e89094c44da98b954eedeac495271d0f": { symbol: "DAI", decimals: 18, name: "Dai Stablecoin" },
  };

  for (const addr of addresses) {
    const normalized = addr.toLowerCase();
    if (commonTokens[normalized]) {
      tokenMap.set(normalized, commonTokens[normalized]);
    } else {
      // Default to 18 decimals for unknown tokens
      tokenMap.set(normalized, { decimals: 18 });
    }
  }

  return tokenMap;
}

/**
 * Smart formatting for different value ranges
 */
export function formatCompactAmount(hex: string, decimals: number = 18, symbol?: string): string {
  const decimal = hexToDecimal(hex, decimals);
  const num = parseFloat(decimal);

  let formatted: string;
  if (num >= 1_000_000_000) {
    formatted = (num / 1_000_000_000).toFixed(2) + "B";
  } else if (num >= 1_000_000) {
    formatted = (num / 1_000_000).toFixed(2) + "M";
  } else if (num >= 1_000) {
    formatted = (num / 1_000).toFixed(2) + "K";
  } else if (num >= 1) {
    formatted = num.toFixed(2);
  } else if (num > 0) {
    formatted = num.toFixed(6).replace(/\.?0+$/, "");
  } else {
    formatted = "0";
  }

  return symbol ? `${formatted} ${symbol}` : formatted;
}
