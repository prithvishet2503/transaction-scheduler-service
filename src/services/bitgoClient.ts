import { BitGoAPI } from '@bitgo/sdk-api';
import type { BaseCoin, CoinConstructor } from '@bitgo/sdk-core';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * BitGo access for the scheduler's server-side execution.
 *
 * Runtime paths — balance pre-check (FR-10), txrequest create + poll — go
 * through the plain REST TxRequests API against `env.bitgoBaseUrl`
 * (staging: https://app.bitgo-staging.com), authenticated with a long-lived
 * spend-scoped access token from the environment. The BitGoJS SDK is only
 * used for offline destination-address validation.
 *
 * NOTE: BitGo does NOT enforce sufficient funds for us here — the scheduler
 * performs an explicit balance pre-check before creating a txrequest (FR-10),
 * and treats a server-side `insufficient_funds` error as a default (FR-11).
 */

/** Spendable + fee-adjusted maximum for a wallet (see `checkBalance`). */
export interface BalanceSnapshot {
  spendable: string;
  maximumSpendable: string | null;
}

/** Reduced view of a txrequest's latest version (see `fetchLatestTxRequest`). */
export interface TxRequestView {
  txRequestId: string;
  state: string;
  isCanceled: boolean;
  txHashes: string[];
}

export class BitGoClient {
  private bitgo: BitGoAPI | null = null;
  private readonly registered = new Set<string>();

  /** Lazily construct and cache the BitGoAPI instance. */
  private client(): BitGoAPI {
    if (!this.bitgo) {
      this.bitgo = new BitGoAPI({
        env: env.bitgoEnv,
        accessToken: env.bitgoAccessToken,
      });
      this.registerCoins();
    }
    return this.bitgo;
  }

  /** Register the configured per-coin SDK modules. */
  private registerCoins(): void {
    for (const coinName of env.coins) {
      this.registerCoin(coinName);
    }
  }

  private registerCoin(coinName: string): void {
    if (this.registered.has(coinName)) {
      return;
    }
    const coinClass = this.loadCoinClass(coinName);
    if (!coinClass || (typeof coinClass !== 'object' && typeof coinClass !== 'function') || !('createInstance' in coinClass)) {
      logger.warn({ coinName }, 'no coin class registered — address validation will be lenient');
      return;
    }
    const createInstance = coinClass.createInstance;
    if (typeof createInstance === 'function') {
      // Boundary cast: the coin module's factory is structurally a
      // CoinConstructor; the SDK's own example registers it this way.
      const ctor = createInstance as unknown as CoinConstructor;
      this.bitgo!.register(coinName, ctor);
      this.registered.add(coinName);
      logger.debug({ coinName }, 'registered coin class');
    }
  }

  /**
   * Resolve the coin *class* for a coin name. Per-coin SDK packages export
   * one class per coin (each with `createInstance`). EVM-family coins
   * (`tbaseeth`, `baseeth`, `teth`, `opeth`, ...) are all handled by the
   * generic `EvmCoin` class from `@bitgo/sdk-coin-evm`.
   */
  private loadCoinClass(coinName: string): unknown {
    try {
      switch (coinName) {
        case 'tbtc':
          return require('@bitgo/sdk-coin-btc').Tbtc;
        case 'btc':
          return require('@bitgo/sdk-coin-btc').Btc;
        case 'tbaseeth':
        case 'baseeth':
        case 'teth':
        case 'eth':
        case 'hteth':
        case 'topeth':
        case 'opeth':
        case 'tarbeth':
        case 'arbeth':
        case 'tzketh':
        case 'zketh':
          return require('@bitgo/sdk-coin-evm').EvmCoin;
        default: {
          const bare = coinName.replace(/^t/, '');
          const className = bare.charAt(0).toUpperCase() + bare.slice(1);
          const mod = require(`@bitgo/sdk-coin-${bare}`);
          return mod[className] ?? mod[coinName.charAt(0).toUpperCase() + coinName.slice(1)];
        }
      }
    } catch (err) {
      logger.debug({ coinName, err }, 'coin class not available');
      return null;
    }
  }

  /** Resolve a coin instance (registers its module on demand). */
  coin(coinName: string): BaseCoin {
    // client() lazily constructs `bitgo` and registers configured coins.
    const bitgo = this.client();
    this.registerCoin(coinName);
    return bitgo.coin(coinName) as unknown as BaseCoin;
  }

  /**
   * Thin REST layer for the TxRequests API. The runtime paths (balance
   * pre-check, txrequest create + poll) go through plain REST against
   * `env.bitgoBaseUrl`; the SDK is only used for offline address validation.
   */
  private async api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${env.bitgoBaseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${env.bitgoAccessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`bitgo api ${res.status}: ${text.slice(0, 300)}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as T;
  }


  /**
   * Validate a destination address for a coin. Falls back to a lenient
   * pass if the coin module isn't available (demo/testnet flexibility).
   */
  async isValidAddress(coinName: string, address: string): Promise<boolean> {
    try {
      const coin = this.coin(coinName);
      if (typeof coin.isValidAddress === 'function') {
        return coin.isValidAddress(address) as boolean;
      }
    } catch (err) {
      logger.warn({ coinName, address, err }, 'address validation unavailable');
    }
    return /^[A-Za-z0-9]{8,}$/.test(address);
  }
  async checkBalance(coinName: string, walletId: string, recipientAddress: string): Promise<BalanceSnapshot> {
    const wallet = await this.api<{ spendableBalanceString?: string }>(
      'GET',
      `/api/v2/${coinName}/wallet/${walletId}`,
    );
    let maximumSpendable: string | null = null;
    try {
      const ms = await this.api<{ maximumSpendable?: string }>(
        'GET',
        `/api/v2/${coinName}/wallet/${walletId}/maximumSpendable?address=${encodeURIComponent(recipientAddress)}`,
      );
      maximumSpendable = ms.maximumSpendable ?? null;
    } catch (err) {
      logger.debug({ walletId, err }, 'maximumSpendable unavailable');
    }
    return {
      spendable: wallet.spendableBalanceString ?? '0',
      maximumSpendable,
    };
  }

  /** Create a txrequest for one intent (payment / transferToken). */
  async createTxRequest(
    walletId: string,
    intent: Record<string, unknown>,
  ): Promise<{ txRequestId: string; state: string }> {
    const res = await this.api<{ txRequestId: string; state: string }>(
      'POST',
      `/api/v2/wallet/${walletId}/txrequests`,
      { apiVersion: 'full', intent },
    );
    return { txRequestId: res.txRequestId, state: res.state };
  }

  /** Latest version of a txrequest, reduced to the fields the poller needs. */
  async fetchLatestTxRequest(walletId: string, txRequestId: string): Promise<TxRequestView | null> {
    const res = await this.api<{
      txRequests?: Array<{
        txRequestId: string;
        state?: string;
        isCanceled?: boolean;
        transactions?: Array<{ txHash?: string }>;
      }>;
    }>(
      'GET',
      `/api/v2/wallet/${walletId}/txrequests?txRequestIds=${encodeURIComponent(txRequestId)}&latest=true`,
    );
    const txr = res.txRequests?.[0];
    if (!txr) {
      return null;
    }
    return {
      txRequestId: txr.txRequestId,
      state: txr.state ?? 'unknown',
      isCanceled: txr.isCanceled === true,
      txHashes: (txr.transactions ?? [])
        .map((t) => t.txHash)
        .filter((h): h is string => typeof h === 'string' && h.length > 0),
    };
  }
}

export const bitgoClient = new BitGoClient();
