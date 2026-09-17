import { BitGoAPI } from '@bitgo/sdk-api';
import type { BaseCoin, CoinConstructor } from '@bitgo/sdk-core';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Thin wrapper over the BitGoJS SDK for the scheduler's server-side execution.
 *
 * Authentication uses a long-lived, spend-scoped access token. For the
 * hackathon demo the token + wallet passphrase are supplied via environment
 * variables (hardcoded in `.env`); a production deployment would source these
 * from a secret manager instead (see docs/EXTERNAL-INTEGRATIONS.md).
 *
 * NOTE: the SDK does NOT enforce sufficient funds client-side — the scheduler
 * performs an explicit balance pre-check before calling `sendMany` (FR-10),
 * and treats a server-side `insufficient_funds` error as a default (FR-11).
 */

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

  async getWallet(coinName: string, walletId: string) {
    const coin = this.coin(coinName);
    return coin.wallets().get({ id: walletId });
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

  /**
   * Balance pre-check (FR-10). Returns spendable + fee-adjusted maximum.
   * `maximumSpendable` may be unavailable for some coins → null.
   */
  async checkBalance(coinName: string, walletId: string, recipientAddress: string) {
    const wallet = await this.getWallet(coinName, walletId);
    await wallet.refresh();
    let maximumSpendable: string | null = null;
    try {
      const res = await wallet.maximumSpendable({ recipientAddress });
      maximumSpendable = String(res?.maximumSpendable ?? '');
    } catch (err) {
      logger.debug({ walletId, err }, 'maximumSpendable unavailable');
    }
    return {
      spendable: wallet.spendableBalanceString() as string,
      maximumSpendable,
    };
  }

  /**
   * Create + submit a single-recipient transaction through the normal BitGo
   * pipeline. `sequenceId` makes retries idempotent (FR-6).
   */
  async sendMany(params: {
    coin: string;
    walletId: string;
    address: string;
    amount: string;
    minConfirms?: number;
    sequenceId: string;
    comment?: string;
  }) {
    const wallet = await this.getWallet(params.coin, params.walletId);
    return wallet.sendMany({
      recipients: [{ address: params.address, amount: params.amount }],
      walletPassphrase: env.bitgoWalletPassphrase,
      minConfirms: params.minConfirms ?? 0,
      sequenceId: params.sequenceId,
      comment: params.comment,
    });
  }
}

export const bitgoClient = new BitGoClient();
