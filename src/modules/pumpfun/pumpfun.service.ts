import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import type { Container } from '../../infra/container.js';

// Program IDs
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_FEES_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

// Instruction discriminators
const BUY_DISCRIMINATOR = Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]);
const SELL_DISCRIMINATOR = Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]);

// Default fee: 1%
const DEFAULT_FEE_BPS = 100n;

export interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: PublicKey;
}

export interface PumpQuote {
  amountIn: bigint;
  amountOut: bigint;
  priceImpactBps: number;
}

export class PumpFunService {
  private readonly container: Container;

  constructor(container: Container) {
    this.container = container;
  }

  // --- PDA derivation ---

  getBondingCurvePDA(mint: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mint.toBuffer()],
      PUMP_PROGRAM_ID,
    );
    return pda;
  }

  getAssociatedBondingCurve(mint: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('associated-bonding-curve'), mint.toBuffer()],
      PUMP_PROGRAM_ID,
    );
    return pda;
  }

  getGlobalPDA(): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('global')],
      PUMP_PROGRAM_ID,
    );
    return pda;
  }

  getCreatorVaultPDA(creator: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('creator-vault'), creator.toBuffer()],
      PUMP_PROGRAM_ID,
    );
    return pda;
  }

  // --- Bonding curve state ---

  async getBondingCurveState(mint: PublicKey): Promise<BondingCurveState> {
    const { connection } = this.container.solana;
    const bondingCurve = this.getBondingCurvePDA(mint);

    const accountInfo = await connection.getAccountInfo(bondingCurve);
    if (!accountInfo) {
      throw new Error(`Bonding curve not found for mint ${mint.toBase58()}`);
    }

    return this.parseBondingCurveData(accountInfo.data);
  }

  private parseBondingCurveData(data: Buffer): BondingCurveState {
    // Skip 8-byte discriminator
    let offset = 8;

    const virtualTokenReserves = data.readBigUInt64LE(offset);
    offset += 8;
    const virtualSolReserves = data.readBigUInt64LE(offset);
    offset += 8;
    const realTokenReserves = data.readBigUInt64LE(offset);
    offset += 8;
    const realSolReserves = data.readBigUInt64LE(offset);
    offset += 8;
    const tokenTotalSupply = data.readBigUInt64LE(offset);
    offset += 8;
    const complete = data.readUInt8(offset) === 1;
    offset += 1;
    const creator = new PublicKey(data.subarray(offset, offset + 32));

    return {
      virtualTokenReserves,
      virtualSolReserves,
      realTokenReserves,
      realSolReserves,
      tokenTotalSupply,
      complete,
      creator,
    };
  }

  // --- Quote math (constant product) ---

  calculateBuyQuote(state: BondingCurveState, solAmountIn: bigint): PumpQuote {
    const netSol = (solAmountIn * 10000n) / (10000n + DEFAULT_FEE_BPS);

    const tokensOut =
      (netSol * state.virtualTokenReserves) / (state.virtualSolReserves + netSol);

    const capped = tokensOut > state.realTokenReserves ? state.realTokenReserves : tokensOut;

    const spotPrice = (state.virtualSolReserves * 10000n) / state.virtualTokenReserves;
    const execPrice = solAmountIn > 0n ? (solAmountIn * 10000n) / capped : 0n;
    const impact = spotPrice > 0n ? Number(((execPrice - spotPrice) * 10000n) / spotPrice) : 0;

    return {
      amountIn: solAmountIn,
      amountOut: capped,
      priceImpactBps: Math.max(0, impact),
    };
  }

  calculateSellQuote(state: BondingCurveState, tokenAmountIn: bigint): PumpQuote {
    const grossSol =
      (tokenAmountIn * state.virtualSolReserves) /
      (state.virtualTokenReserves + tokenAmountIn);

    const netSol = (grossSol * (10000n - DEFAULT_FEE_BPS)) / 10000n;
    const capped = netSol > state.realSolReserves ? state.realSolReserves : netSol;

    const spotPrice = (state.virtualSolReserves * 10000n) / state.virtualTokenReserves;
    const execPrice = tokenAmountIn > 0n ? (capped * 10000n) / tokenAmountIn : 0n;
    const impact = spotPrice > 0n ? Number(((spotPrice - execPrice) * 10000n) / spotPrice) : 0;

    return {
      amountIn: tokenAmountIn,
      amountOut: capped,
      priceImpactBps: Math.max(0, impact),
    };
  }

  // --- Instruction builders ---

  async buildBuyInstruction(
    mint: PublicKey,
    buyer: PublicKey,
    tokenAmount: bigint,
    maxSolCost: bigint,
  ): Promise<TransactionInstruction> {
    const state = await this.getBondingCurveState(mint);
    if (state.complete) {
      throw new Error('Bonding curve is complete — trade on PumpSwap AMM instead');
    }

    const bondingCurve = this.getBondingCurvePDA(mint);
    const associatedBondingCurve = this.getAssociatedBondingCurve(mint);
    const global = this.getGlobalPDA();
    const creatorVault = this.getCreatorVaultPDA(state.creator);
    const buyerAta = getAssociatedTokenAddressSync(mint, buyer);

    const data = Buffer.alloc(8 + 8 + 8);
    BUY_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(tokenAmount, 8);
    data.writeBigUInt64LE(maxSolCost, 16);

    return new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      keys: [
        { pubkey: global, isSigner: false, isWritable: false },
        { pubkey: PUMP_FEES_PROGRAM_ID, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: buyerAta, isSigner: false, isWritable: true },
        { pubkey: buyer, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: creatorVault, isSigner: false, isWritable: true },
      ],
      data,
    });
  }

  async buildSellInstruction(
    mint: PublicKey,
    seller: PublicKey,
    tokenAmount: bigint,
    minSolOutput: bigint,
  ): Promise<TransactionInstruction> {
    const state = await this.getBondingCurveState(mint);
    if (state.complete) {
      throw new Error('Bonding curve is complete — trade on PumpSwap AMM instead');
    }

    const bondingCurve = this.getBondingCurvePDA(mint);
    const associatedBondingCurve = this.getAssociatedBondingCurve(mint);
    const global = this.getGlobalPDA();
    const creatorVault = this.getCreatorVaultPDA(state.creator);
    const sellerAta = getAssociatedTokenAddressSync(mint, seller);

    const data = Buffer.alloc(8 + 8 + 8);
    SELL_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(tokenAmount, 8);
    data.writeBigUInt64LE(minSolOutput, 16);

    return new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      keys: [
        { pubkey: global, isSigner: false, isWritable: false },
        { pubkey: PUMP_FEES_PROGRAM_ID, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: sellerAta, isSigner: false, isWritable: true },
        { pubkey: seller, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: creatorVault, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  // --- Helpers ---

  applySlippage(amount: bigint, slippageBps: number, isBuy: boolean): bigint {
    if (isBuy) {
      // For buys: max cost = quote * (1 + slippage)
      return (amount * BigInt(10000 + slippageBps)) / 10000n;
    }
    // For sells: min output = quote * (1 - slippage)
    return (amount * BigInt(10000 - slippageBps)) / 10000n;
  }

  getProgramId(): PublicKey {
    return PUMP_PROGRAM_ID;
  }
}
