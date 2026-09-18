import { BitGoAPI } from '@bitgo/sdk-api';
import type { BaseCoin, CoinConstructor } from '@bitgo/sdk-core';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * BitGo access for the scheduler's server-side execution.
 *
 * Authentication uses a long-lived, spend-scoped access token. For the
 * hackathon demo the token + wallet passphrase are supplied via environment
 * variables (hardcoded in `.env`); a production deployment would source these
 * from a secret manager instead (see docs/EXTERNAL-INTEGRATIONS.md).
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
        accessToken: env.bitgoTestAccessToken,
      });
      this.registerCoins();
    }
    return this.bitgo;
  }

  /** Register the configured per-coin SDK modules. */
  private registerCoins(): void {
    for (const name of env.coins) {
      this.registerCoin(name);
    }
  }

  private registerCoin(coinName: string): void {
    if (this.registered.has(coinName)) return;

    try {
      // Prefer the package's register/registerAll function when available
      switch (coinName) {
        case 'tsol':
        case 'sol':
          require('@bitgo/sdk-coin-sol').register(this.client());
          this.registered.add(coinName);
          return;
        case 'tbaseeth':
        case 'baseeth':
        case 'teth':
        case 'eth': {
          const evmPkg = require('@bitgo/sdk-coin-evm');
          if (typeof evmPkg.registerAll === 'function') {
            evmPkg.registerAll(this.client());
          } else if (typeof evmPkg.register === 'function') {
            evmPkg.register(this.client());
          }
          this.registered.add(coinName);
          return;
        }
        case 'tbtc':
          require('@bitgo/sdk-coin-btc').register?.(this.client());
          this.registered.add(coinName);
          return;
      }

      // Fallback: try loading the class and using its register function
      const pkgName = coinName.startsWith('t') ? coinName.slice(1) : coinName;
      try {
        const pkg = require(`@bitgo/sdk-coin-${pkgName}`);
        if (typeof pkg.register === 'function') {
          pkg.register(this.client());
          this.registered.add(coinName);
        } else {
          logger.warn({ coinName }, 'no register() function found in package');
        }
      } catch {
        logger.warn({ coinName }, 'no SDK package found for coin');
      }
    } catch (err) {
      logger.warn({ coinName, err }, 'failed to register coin');
    }
  }

  /** Resolve a coin instance (registers its module on demand). */
  coin(coinName: string): BaseCoin {
    if (!this.registered.has(coinName)) {
      this.registerCoin(coinName);
    }
    return this.client().coin(coinName);
  }

  async getWallet(coinName: string, walletId: string) {
    return this.coin(coinName).wallets().get({ id: walletId });
  }

  /**
   * Thin REST layer for the TxRequests API. Runtime paths (balance
   * pre-check, txrequest create + poll) go through plain REST against
   * `env.bitgoBaseUrl`; the SDK is used for address validation and staking.
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
   * Stake an amount from a custody wallet.
   * wallet.toStakingWallet().stake({ amount }) → POST /api/staking/v1/{coin}/wallets/{id}/requests
   */
  async stake(coinName: string, walletId: string, amount: string): Promise<{ id: string; status: string }> {
    const wallet = await this.getWallet(coinName, walletId);
    const result = await wallet.toStakingWallet().stake({ amount });
    logger.info({ walletId, coin: coinName, amount, requestId: result.id }, 'stake request submitted via SDK');
    return { id: result.id, status: result.status };
  }

  /**
   * Unstake from a specific delegation.
   * wallet.toStakingWallet().unstake({ delegationId, clientId })
   */
  async unstake(
    coinName: string,
    walletId: string,
    delegationId: string,
    clientId?: string,
  ): Promise<{ id: string; status: string }> {
    const wallet = await this.getWallet(coinName, walletId);
    const result = await wallet.toStakingWallet().unstake({ delegationId, clientId });
    logger.info({ walletId, coin: coinName, delegationId, requestId: result.id }, 'unstake request submitted via SDK');
    return { id: result.id, status: result.status };
  }

  /**
   * Delegations / staking wallet info.
   * GET /api/staking/v1/{coin}/wallets/{id}/delegations
   */
  async getStakingInfo(coinName: string, walletId: string) {
    const wallet = await this.getWallet(coinName, walletId);
    return wallet.toStakingWallet().delegations({});
  }

  async isValidAddress(coinName: string, address: string): Promise<boolean> {
    if (env.bitgoMode === 'demo') {
      logger.warn({ coinName, address }, 'demo mode: skipping coin address validation');
      return /^[A-Za-z0-9]{8,}$/.test(address);
    }
    try {
      const coin = this.coin(coinName);
      if (typeof coin.isValidAddress === 'function') {
        return coin.isValidAddress(address) as boolean;
      }
    } catch (err) {
      logger.warn({ coinName, address, err }, 'address validation unavailable');
    }
    return true;
  }
  /**
   * Balance pre-check (FR-10). Returns spendable + fee-adjusted maximum.
   * `maximumSpendable` may be unavailable for some coins → null.
   */
  async checkBalance(
    coinName: string,
    walletId: string,
    recipientAddress: string,
  ): Promise<BalanceSnapshot> {
    if (env.bitgoMode === 'demo') {
      logger.warn(
        { coinName, walletId, spendable: env.demoSpendable },
        'demo mode: returning configured spendable balance',
      );
      return { spendable: env.demoSpendable, maximumSpendable: null };
    }
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
      logger.warn({ err }, 'maximumSpendable unavailable');
    }
    return { spendable: wallet.spendableBalanceString ?? '0', maximumSpendable };
  }

  /** Enterprise-owned recipient balance, backed by BitGo's feeAddressBalance endpoint. */
  async getEnterpriseRecipientBalance(enterpriseId: string, coin: string): Promise<{ balance: string; address: string }> {
    const baseUrl = env.bitgoBaseUrl;
    const res = await fetch(`${baseUrl}/api/v2/${coin}/enterprise/${enterpriseId}/feeAddressBalance`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${env.bitgoTestAccessToken}`,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`enterprise recipient balance failed: ${res.status} ${body.slice(0, 200)}`) as Error & { status?: number };
      err.status = 502;
      throw err;
    }
    const data = (await res.json()) as { balance?: string | number; address?: string };
    if (
      (typeof data.balance !== 'string' && typeof data.balance !== 'number') ||
      typeof data.address !== 'string'
    ) {
      const err = new Error('enterprise recipient balance response malformed') as Error & { status?: number };
      err.status = 502;
      throw err;
    }
    return { balance: String(data.balance), address: data.address };
  }

  /**
   * Resolve an address to the BitGo wallet that owns it (receive address match).
   * Returns null when the address does not belong to any wallet.
   */
  async resolveWalletIdByAddress(coinName: string, address: string): Promise<string | null> {
    if (env.bitgoMode === 'demo') {
      logger.warn({ coinName, address }, 'demo mode: synthesizing wallet id from address');
      return `demo-${address}`;
    }
    try {
      const wallet = await this.api<{ id?: string }>(
        'GET',
        `/api/v2/${coinName}/wallet/address/${encodeURIComponent(address)}`,
      );
      return wallet.id ?? null;
    } catch (err) {
      if (typeof err === 'object' && err !== null && 'status' in err && err.status === 404) {
        return null;
      }
      logger.warn({ coinName, address, err }, 'wallet resolution by address failed');
      return null;
    }
  }


  /** Create a txrequest for one intent (payment / transferToken). */
  async createTxRequest(
    walletId: string,
    intent: Record<string, unknown>,
  ): Promise<{ txRequestId: string; state: string }> {
    if (env.bitgoMode === 'demo') {
      const txRequestId = env.demoPendingApprovalId || `demo-${Date.now().toString(16)}`;
      logger.warn({ walletId, txRequestId }, 'demo mode: simulating txrequest creation');
      return { txRequestId, state: env.demoPendingApprovalId ? 'pendingApproval' : 'approved' };
    }
    const res = await this.api<{ txRequestId: string; state: string }>(
      'POST',
      `/api/v2/wallet/${walletId}/txrequests`,
      { apiVersion: 'full', intent },
    );
    return { txRequestId: res.txRequestId, state: res.state };
  }

  /** Latest version of a txrequest, reduced to the fields the poller needs. */
  async fetchLatestTxRequest(walletId: string, txRequestId: string): Promise<TxRequestView | null> {
    if (env.bitgoMode === 'demo') {
      if (!txRequestId.startsWith('demo-') && txRequestId !== env.demoPendingApprovalId) {
        return null;
      }
      // Simulated hot-wallet flow: broadcast immediately unless a pending
      // approval id is configured (execution then holds pending_approval).
      return {
        txRequestId,
        state: env.demoPendingApprovalId ? 'pendingApproval' : 'approved',
        isCanceled: false,
        txHashes: env.demoPendingApprovalId ? [] : [txRequestId],
      };
    }
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

  /** On-chain state of a broadcast transfer (used by confirmation polling). */
  async getTransferStatus(
    coin: string,
    walletId: string,
    txId: string,
  ): Promise<{ state: string; confirmations: number }> {
    const res = await this.api<{
      transfer?: { state?: string; confirmations?: { count?: number } | number };
    }>('GET', `/api/v2/${coin}/wallet/${walletId}/transfer/${txId}`);
    const transfer = res.transfer ?? {};
    const raw = transfer.confirmations;
    const confirmations =
      typeof raw === 'number' ? raw : (raw?.count ?? 0);
    return { state: transfer.state ?? 'unknown', confirmations };
  }
}

export const bitgoClient = new BitGoClient();