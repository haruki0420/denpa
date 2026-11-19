/**
 * B-CAS カードの有料放送の契約を確かめる。
 *
 * EIT の CA 契約情報記述子 (0xCB) にある verificationData を B-CAS カードに渡し (0x90 0x3C)、
 * 今日と 1 週間後に観られるかと、契約の期限を調べる。記述子の無い局は、チューナーで受けて
 * TS パケットのスクランブル制御ビットを数え、復号できるかを確かめる。
 */
import { PACKET, SYNC } from "@danything/arib/psi";
import { ServiceFilter } from "@danything/arib/service-filter";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

import { contractAgents, readAgentCards } from "./agent-cards";
import {
  NO_CHANNEL,
  serviceChannel,
  servicePlaces,
  strictPlaces,
} from "./agent-channels";
import { fetchAgent } from "./agent-client";
import { type Agent, listAgents } from "./agents";
import { config } from "./config";
import {
  type ContractState,
  type ContractStatus,
  contractStatus,
  DECODE_VALID_MS,
  freshDecode,
} from "./contract-status";
import { orm } from "./db";
import { cardContracts, programs, services } from "./schema";
import {
  cardStatus,
  getActiveCardId,
  mediaPids,
  ScrambleCount,
} from "./scramble";
import { store, stored } from "./settings";
import { openChannelStream } from "./tuner";

export {
  type ContractState,
  type ContractStatus,
  DECODE_VALID_MS,
  freshDecode,
  getActiveCardId,
};

interface ConfirmResult {
  ok: boolean;
  code: number;
  error?: string | undefined;
}

export type ContractSource = "eit_ca" | "decode" | "manual";

export type ContractProviderId = "wowow" | "japanet" | "skyperfect" | "other";

export interface ContractProviderInfo {
  id: ContractProviderId;
  name: string;
}

export const CONTRACT_PROVIDERS: Record<
  ContractProviderId,
  ContractProviderInfo
> = {
  wowow: { id: "wowow", name: "WOWOW" },
  japanet: { id: "japanet", name: "BS10 (ジャパネット)" },
  skyperfect: { id: "skyperfect", name: "スカパー！" },
  other: { id: "other", name: "その他" },
};

/**
 * サービス ID (内部ID: networkId * 100000 + serviceId) から ARIB サービス番号を抽出する
 */
function getAribServiceId(internalId: number): number {
  return internalId % 100000;
}

/**
 * サービス ID や種別から契約管理事業者 (WOWOW / ジャパネット / スカパー！ 等) を判別する。
 */
export function getContractProvider(
  internalId: number,
  type?: string,
  name?: string,
): ContractProviderInfo {
  const serviceId = getAribServiceId(internalId);
  if (
    serviceId === 191 ||
    serviceId === 192 ||
    serviceId === 193 ||
    (name && name.includes("WOWOW") && !name.includes("プラス"))
  ) {
    return CONTRACT_PROVIDERS.wowow;
  }
  if (
    serviceId === 201 ||
    (name && (name.includes("BS10") || name.includes("スターチャンネル")))
  ) {
    return CONTRACT_PROVIDERS.japanet;
  }
  // BSの有料局は 234 以降。CSはすべてスカパー。
  if (type === "CS" || (type === "BS" && serviceId >= 234)) {
    return CONTRACT_PROVIDERS.skyperfect;
  }
  return CONTRACT_PROVIDERS.other;
}

export interface ContractSettings {
  /** 契約期限・予告の案内表示モード */
  modalMode: "modal" | "banner" | "none";
  /** 契約意志のある局 (内部サービスID の配列)。null なら全有料局を対象とする */
  intendedServiceIds: number[] | null;
  /** 深夜などの定期復号スキャンを有効にするか */
  periodicScanEnabled: boolean;
  /** 定期スキャン開始時刻 (HH:MM、例: "03:00") */
  periodicScanStart: string;
  /** 定期スキャン終了時刻 (HH:MM、例: "06:00") */
  periodicScanEnd: string;
}

export function getContractSettings(): ContractSettings {
  const modalRaw = stored("contract_modal_mode");
  const intendedRaw = stored("contract_intended_services");
  const periodicRaw = stored("contract_periodic_scan_enabled");
  const scanStart = stored("contract_periodic_scan_start") || "03:00";
  const scanEnd = stored("contract_periodic_scan_end") || "06:00";

  let intendedServiceIds: number[] | null = null;
  if (intendedRaw) {
    try {
      const parsed = JSON.parse(intendedRaw);
      if (Array.isArray(parsed)) {
        intendedServiceIds = parsed.map(Number);
      }
    } catch {
      intendedServiceIds = null;
    }
  }

  return {
    modalMode:
      modalRaw === "banner" || modalRaw === "none" ? modalRaw : "modal",
    intendedServiceIds,
    periodicScanEnabled: periodicRaw === "1" || periodicRaw === "true",
    periodicScanStart: scanStart,
    periodicScanEnd: scanEnd,
  };
}

export function saveContractSettings(
  patch: Partial<ContractSettings>,
): ContractSettings {
  if (patch.modalMode !== undefined) {
    store("contract_modal_mode", patch.modalMode);
  }
  if (patch.intendedServiceIds !== undefined) {
    store(
      "contract_intended_services",
      patch.intendedServiceIds === null
        ? ""
        : JSON.stringify(patch.intendedServiceIds),
    );
  }
  if (patch.periodicScanEnabled !== undefined) {
    store(
      "contract_periodic_scan_enabled",
      patch.periodicScanEnabled ? "1" : "0",
    );
  }
  if (patch.periodicScanStart !== undefined) {
    store("contract_periodic_scan_start", patch.periodicScanStart);
  }
  if (patch.periodicScanEnd !== undefined) {
    store("contract_periodic_scan_end", patch.periodicScanEnd);
  }
  return getContractSettings();
}

export interface ContractRow {
  cardId: string;
  serviceId: number;
  serviceName: string;
  /** 画面に出す局のチャンネル (`agent-channels.serviceChannel`)。エージェントの控えに無ければ null */
  channel: string | null;
  type: string;
  state: ContractState;
  status: ContractStatus;
  source: ContractSource | null;
  manualState: "subscribed" | "unsubscribed" | "unknown" | null;
  code: number | null;
  validUntil: number | null;
  decodeOk: boolean | null;
  /** 確かめた時刻。行が無い局は null */
  checkedAt: number | null;
  /** この局で利用可能な契約確認方式 */
  availableMethods?: ContractSource[];
  /** 契約管理事業者 */
  providerId: ContractProviderId;
  providerName: string;
  /** 契約意志の対象局か (ユーザーが監視・録画対象に選択しているか) */
  isIntended: boolean;
}

export interface EvaluationInput {
  manualState?: "subscribed" | "unsubscribed" | "unknown" | null | undefined;
  code?: number | null | undefined;
  validUntil?: number | null | undefined;
  decodeOk?: boolean | null | undefined;
  decodedAt?: number | null | undefined;
  hasEitCa?: boolean | undefined;
}

export interface EvaluationResult {
  state: ContractState;
  source: ContractSource | null;
}

/**
 * 契約確認方式の抽象化と優先順位判定を行うチェッカー。
 *
 * 優先順位:
 * 1. 手動設定 (manual): ユーザーが明示的に契約中/未契約/未確認に設定したもの
 * 2. カード確認 (eit_ca): EIT の 0xCB 記述子と B-CAS カード (0x90 0x3C)
 * 3. 実ストリーム復号テスト (decode): TS パケットのスクランブルビット検査
 * 4. 未確認 (unknown): いずれも確かめられていない
 */
export const ContractChecker = {
  /**
   * 優先順位ルールに従って局の契約状態と判定元を決定する。
   */
  evaluate(input: EvaluationInput, nowMs = Date.now()): EvaluationResult {
    // 1. 手動設定
    if (input.manualState != null) {
      return {
        state: input.manualState,
        source: "manual",
      };
    }

    // 2. カード確認 (0x3C コード)
    if (input.code !== null && input.code !== undefined) {
      if (isCodeSubscribed(input.code)) {
        return { state: "subscribed", source: "eit_ca" };
      }
      if (
        input.validUntil !== null &&
        input.validUntil !== undefined &&
        input.validUntil < nowMs
      ) {
        return { state: "expired", source: "eit_ca" };
      }
      return { state: "unsubscribed", source: "eit_ca" };
    }

    // 3. 復号テスト (decode)
    if (input.decodeOk === true) {
      if (freshDecode(input.decodedAt, nowMs)) {
        return { state: "subscribed", source: "decode" };
      }
      // 31 日を経過した場合は契約中とみなさず未確認
      return { state: "unknown", source: "decode" };
    }
    if (input.decodeOk === false) {
      return { state: "unsubscribed", source: "decode" };
    }

    // 4. 未確認
    return {
      state: "unknown",
      source: input.hasEitCa ? "eit_ca" : null,
    };
  },

  /**
   * 局ごとに利用可能な契約確認方式を返す。
   */
  getAvailableMethods(hasEitCa: boolean): ContractSource[] {
    const methods: ContractSource[] = [];
    if (hasEitCa) {
      methods.push("eit_ca");
    }
    methods.push("decode");
    methods.push("manual");
    return methods;
  },
};
const NO_CARD = "B-CAS カードが認識されていません";

/** 確かめるカードで復号するエージェントが、どれも局を受けられないとき (`decodeOnChannel`) */
const NO_CARD_PLACE =
  "このカードで復号するエージェントの控えに、この局のチャンネルがありません";

/** エージェント (渡さなければ並びの先頭) が使っているカードの番号。カードが読めなければ null */
async function usableCardId(agent?: Agent): Promise<string | null> {
  const card = await cardStatus(agent);
  return (card.ok && getActiveCardId(card)) || null;
}

/** Date オブジェクト (または現在) を JST 基準の MJD (修正ユリウス日) に変換 */
export function toMjd(date: Date = new Date()): number {
  const jstMs = date.getTime() + 9 * 3600 * 1000;
  return Math.floor(jstMs / 86_400_000) + 40587;
}

/** MJD から Date (JST 00:00:00 の epoch ms) に変換 */
export function fromMjd(mjd: number): number {
  return (mjd - 40587) * 86_400_000 - 9 * 3600 * 1000;
}

/** 返り値コードから契約有効フラグ (月額 Tier または PPV) が立っているかを判定 */
export function isCodeSubscribed(code: number): boolean {
  // 0x0800: 月額 Tier 有効, 0x0400: 前払い PPV, 0x0200: 後払い PPV。
  // 上の桁や 0x0100 が立つ値 (実機の 0x8901 など) は契約の答えではないので、契約中とは見ない
  return (code & 0x0e00) !== 0 && (code & 0xf100) === 0;
}

/**
 * B-CAS カードの契約確認コマンド (0x90 0x3C) を、そのカードを使うエージェント経由で呼び出す
 */
export async function confirmCardContract(
  verificationBase64: string,
  dateMjd: number,
  agent: Agent,
): Promise<ConfirmResult> {
  try {
    const res = await fetchAgent(agent, "/denpa/card/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        verification: verificationBase64,
        date: dateMjd,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      return {
        ok: false,
        code: 0,
        error: `エージェント応答エラー (${res.status}): ${err}`,
      };
    }
    const data = (await res.json()) as {
      ok?: boolean;
      code?: number;
      error?: string;
    };
    return {
      ok: data.ok === true,
      code: typeof data.code === "number" ? data.code : 0,
      error: data.error,
    };
  } catch (error) {
    return { ok: false, code: 0, error: String(error) };
  }
}

/**
 * 有料放送局の最新の CA 契約情報を、カードごとに確かめて card_contracts テーブルを更新する。
 *
 * カードは全部のエージェントの `/denpa/card` から集め、1 枚につき 1 台に問い合わせる (`agent-cards.contractAgents`。
 * そのカードを手元に持つエージェント、無ければそのカードから鍵を貰うエージェント)。カードは世帯で 1 枚の勧めどおりなら、問い合わせるのは 1 台。
 * 1 枚で問い合わせに失敗しても、ほかのカードは確かめてから送出する。
 * 返すのは、設定のダイアログに出すカード (並びの先頭のエージェントのカード。無ければ最初に見つけたカード) の行
 */
export async function checkContracts(): Promise<ContractRow[]> {
  const agents = listAgents();
  const cards = await readAgentCards(agents);
  const holders = contractAgents(cards);
  if (holders.size === 0) {
    throw new Error(
      cards[0]?.status.message ||
        "B-CAS カードが認識されていないため契約を確認できません",
    );
  }

  // 有料番組を持つ局 (局の表にあるものだけ) と、その局の新しい番組の契約確認情報 (無ければ null)
  const serviceVerifications = new Map<number, string | null>();
  for (const prog of orm()
    .select({
      serviceId: programs.service_id,
      verification: programs.contract_verification,
    })
    .from(programs)
    .innerJoin(services, eq(services.id, programs.service_id))
    .where(eq(programs.is_free, false))
    .orderBy(desc(programs.start_at))
    .all()) {
    if (!serviceVerifications.get(prog.serviceId))
      serviceVerifications.set(prog.serviceId, prog.verification ?? null);
  }
  if (serviceVerifications.size === 0) return [];

  let failure: unknown = null;
  for (const [cardId, holder] of holders) {
    const agent = agents.find((a) => a.id === holder)!;
    try {
      await checkCard(cardId, agent, serviceVerifications);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== null) throw failure;
  return getContractRows(cards[0]?.card ?? [...holders.keys()][0]!);
}

/** 1 枚のカード `cardId` の契約を、エージェント `agent` に問い合わせて書く (`checkContracts`) */
async function checkCard(
  cardId: string,
  agent: Agent,
  serviceVerifications: ReadonlyMap<number, string | null>,
): Promise<void> {
  const serviceIds = [...serviceVerifications.keys()];

  // 既存の契約レコード（前回の復号結果や手動設定等）を取得して保持する
  const existingContracts = orm()
    .select({
      serviceId: cardContracts.service_id,
      state: cardContracts.state,
      manualState: cardContracts.manual_state,
      code: cardContracts.code,
      validUntil: cardContracts.valid_until,
      decodeOk: cardContracts.decode_ok,
      decodedAt: cardContracts.decoded_at,
    })
    .from(cardContracts)
    .where(
      and(
        eq(cardContracts.card_id, cardId),
        inArray(cardContracts.service_id, serviceIds),
      ),
    )
    .all();
  const existingMap = new Map(existingContracts.map((c) => [c.serviceId, c]));

  const nowMs = Date.now();
  const todayMjd = toMjd(new Date(nowMs));

  for (const [serviceId, verification] of serviceVerifications) {
    const existing = existingMap.get(serviceId);

    let code: number | null = null;
    let validUntil: number | null = null;

    if (verification) {
      /** その日 (今日からの日数) に観られるか。カードに聞けなければ例外にする (今の行を上書きしない) */
      const valid = async (days: number): Promise<boolean> => {
        const res = await confirmCardContract(
          verification,
          todayMjd + days,
          agent,
        );
        if (!res.ok) {
          throw new Error(
            `B-CAS カードへの問い合わせに失敗しました (${serviceId}): ${res.error}`,
          );
        }
        if (days === 0) code = res.code;
        return isCodeSubscribed(res.code);
      };
      /** `from` 日目は観られて `to` 日目は観られないとき、観られる最後の日 (2 分探索) */
      const lastValid = async (from: number, to: number): Promise<number> => {
        while (to - from > 1) {
          const mid = Math.floor((from + to) / 2);
          if (await valid(mid)) from = mid;
          else to = mid;
        }
        return from;
      };
      if (await valid(0)) {
        // 今日は観られる。**1 週間以内に切れても契約中のまま**にし、期限の日だけ覚える
        // (期限切れにすると、まだ観られる局のカードが振り分けで後回しになる)
        if (!(await valid(7)))
          // 期限日の翌日 0 時 (JST) が満了
          validUntil = fromMjd(todayMjd + (await lastValid(0, 7)) + 1);
      } else if (await valid(-30)) {
        // 30 日のうちに切れた
        validUntil = fromMjd(todayMjd + (await lastValid(-30, 0)) + 1);
      }
    }

    const evaluated = ContractChecker.evaluate(
      {
        manualState: existing?.manualState,
        code,
        validUntil,
        decodeOk: existing?.decodeOk,
        decodedAt: existing?.decodedAt,
        hasEitCa: Boolean(verification),
      },
      nowMs,
    );

    orm()
      .insert(cardContracts)
      .values({
        card_id: cardId,
        service_id: serviceId,
        state: evaluated.state,
        source: evaluated.source,
        manual_state: existing?.manualState ?? null,
        code,
        valid_until: validUntil,
        decode_ok: existing?.decodeOk ?? null,
        decoded_at: existing?.decodedAt ?? null,
        checked_at: nowMs,
      })
      .onConflictDoUpdate({
        target: [cardContracts.card_id, cardContracts.service_id],
        set: {
          state: evaluated.state,
          source: evaluated.source,
          code,
          valid_until: validUntil,
          checked_at: nowMs,
        },
      })
      .run();
  }
}

/**
 * カードの契約の一覧 (設定のダイアログ)。card_contracts の行に、番組表に有料の番組があって行がまだ無い局を
 * 「確かめていない」として足す。並びは種別、局の番号の順
 */
export function getContractRows(
  cardId: string,
  now = Date.now(),
): ContractRow[] {
  const contractSettings = getContractSettings();

  // 0xCB (CA 契約情報) を持つ有料局の一覧を取得
  const servicesWithEitCa = new Set(
    orm()
      .select({ serviceId: programs.service_id })
      .from(programs)
      .where(
        and(
          eq(programs.is_free, false),
          sql`${programs.contract_verification} IS NOT NULL`,
        ),
      )
      .all()
      .map((p) => p.serviceId),
  );

  const rawRows = orm()
    .select({
      cardId: cardContracts.card_id,
      serviceId: cardContracts.service_id,
      serviceName: services.name,
      channel: serviceChannel(),
      type: services.type,
      arib: services.service_id,
      state: cardContracts.state,
      source: cardContracts.source,
      manualState: cardContracts.manual_state,
      code: cardContracts.code,
      validUntil: cardContracts.valid_until,
      decodeOk: cardContracts.decode_ok,
      decodedAt: cardContracts.decoded_at,
      checkedAt: cardContracts.checked_at,
    })
    .from(cardContracts)
    .innerJoin(services, eq(services.id, cardContracts.service_id))
    .where(eq(cardContracts.card_id, cardId))
    .orderBy(asc(services.type), asc(services.service_id))
    .all();

  let rows: (ContractRow & { arib: number })[] = rawRows.map(
    ({ decodedAt, ...row }) => {
      const provider = getContractProvider(
        row.serviceId,
        row.type,
        row.serviceName,
      );
      const isIntended =
        contractSettings.intendedServiceIds === null
          ? true
          : contractSettings.intendedServiceIds.includes(row.serviceId);
      return {
        ...row,
        status: contractStatus({ ...row, decodedAt }, now),
        availableMethods: ContractChecker.getAvailableMethods(
          servicesWithEitCa.has(row.serviceId),
        ),
        providerId: provider.id,
        providerName: provider.name,
        isIntended,
      };
    },
  );

  const known = new Set(rows.map((row) => row.serviceId));
  const missing = orm()
    .selectDistinct({
      serviceId: services.id,
      serviceName: services.name,
      channel: serviceChannel(),
      type: services.type,
      arib: services.service_id,
    })
    .from(programs)
    .innerJoin(services, eq(services.id, programs.service_id))
    .where(eq(programs.is_free, false))
    .all()
    .filter((service) => !known.has(service.serviceId));
  for (const service of missing) {
    const provider = getContractProvider(
      service.serviceId,
      service.type,
      service.serviceName,
    );
    const isIntended =
      contractSettings.intendedServiceIds === null
        ? true
        : contractSettings.intendedServiceIds.includes(service.serviceId);
    rows.push({
      cardId,
      ...service,
      state: "unsubscribed",
      status: "unverified",
      source: null,
      manualState: null,
      code: null,
      validUntil: null,
      decodeOk: null,
      checkedAt: null,
      availableMethods: ContractChecker.getAvailableMethods(
        servicesWithEitCa.has(service.serviceId),
      ),
      providerId: provider.id,
      providerName: provider.name,
      isIntended,
    });
  }

  // 1. WOWOW の 3 局連動同期 (同一の直契約)
  // WOWOW の代表局 (プライム/ライブ/シネマ) でカード確認 (eit_ca) ができている場合、
  // 手動設定や独自のコードが無い他の WOWOW 局も同一契約として同期する
  const wowowRep = rows.find(
    (r) =>
      r.providerId === "wowow" &&
      r.source === "eit_ca" &&
      (r.code !== null || r.validUntil !== null),
  );
  if (wowowRep) {
    rows = rows.map((r) => {
      if (r.providerId === "wowow" && r.manualState == null && r.code == null) {
        return {
          ...r,
          state: wowowRep.state,
          status: wowowRep.status,
          source: "eit_ca",
          validUntil: wowowRep.validUntil,
        };
      }
      return r;
    });
  }

  // 2. スカパー！の一括同期
  // スカパー！の代表局 (スカチャン1 等) でカード契約が確認できている場合、
  // 手動設定されていない他のスカパー局も同一の契約状態・期限とみなす
  const skyRep = rows.find(
    (r) =>
      r.providerId === "skyperfect" &&
      (getAribServiceId(r.serviceId) === 800 ||
        Boolean(r.serviceName?.includes("スカチャン"))) &&
      r.source === "eit_ca" &&
      (r.code !== null || r.validUntil !== null),
  );
  if (skyRep) {
    rows = rows.map((r) => {
      if (
        r.providerId === "skyperfect" &&
        r.manualState == null &&
        r.code == null
      ) {
        return {
          ...r,
          state: skyRep.state,
          status: skyRep.status,
          source: "eit_ca",
          validUntil: skyRep.validUntil,
        };
      }
      return r;
    });
  }

  rows.sort((a, b) => {
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.arib - b.arib;
  });
  return rows.map((entry) => {
    const { arib: _, ...row } = entry;
    return row;
  });
}

/** 復号を確かめた 1 局の結果。`ok` が false なら確かめられなかった (`error` に理由) */
interface DecodeResult {
  ok: boolean;
  decodeOk: boolean;
  error?: string;
}

/** 復号を確かめる局を読む `services` の列 */
const DECODE_TARGET = {
  id: services.id,
  arib: services.service_id,
  type: services.type,
  places: servicePlaces(),
};

/** 復号を確かめる局 (`DECODE_TARGET` で読んだ行) */
interface DecodeTarget {
  id: number;
  arib: number;
  type: string;
  /** 局を受けられる所 (`agent-channels.servicePlaces`)。どの控えにも無ければ null */
  places: string | null;
}

/** 局ごとにパケットを数える長さ。これだけ数えたら、15 秒を待たずに判定する */
const DECODE_PACKETS = 2000;

/**
 * **同じ TS の局を 1 つの組にまとめる** (`testDecodeUnverified`)。1 つの組は 1 回の選局で確かめる。
 * 同じ TS は、局を受けられる所 (`places`。エージェントとそのチャンネル) が同じになる。組と組の中の並びは、渡した順
 */
export function groupByChannel<
  T extends { type: string; places: string | null },
>(targets: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const target of targets) {
    const key = `${target.type} ${target.places}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [target]);
    else group.push(target);
  }
  return [...groups.values()];
}

/**
 * **復号を確かめるカードと、そのカードで復号するエージェント** (`testDecode`・`testDecodeUnverified`)。
 * カードは設定のダイアログを開いたエージェント (`agent`。渡さなければ並びの先頭) のカード。エージェントは、手元に持つものも鍵を貰うものも入れる。
 * そのエージェントがカードを読めなければ null
 */
async function decodeCard(agent?: number): Promise<{
  card: string;
  agents: ReadonlySet<number>;
} | null> {
  const cards = await readAgentCards();
  const card =
    (agent === undefined ? cards[0] : cards.find((c) => c.agent === agent))
      ?.card ?? null;
  if (card === null) return null;
  return {
    card,
    agents: new Set(cards.filter((c) => c.card === card).map((c) => c.agent)),
  };
}

/**
 * **いまその局で流れている番組が有料のときだけ確かめる。** 無料の時間帯は契約が無くても
 * スクランブルが掛かっていないので、復号できたように見えて契約中と取り違える。確かめられないときはその理由
 */
function notPaidNow(serviceId: number, now: number): string | null {
  const airing = orm()
    .select({ isFree: programs.is_free })
    .from(programs)
    .where(
      and(
        eq(programs.service_id, serviceId),
        lte(programs.start_at, now),
        gt(programs.end_at, now),
      ),
    )
    .get();
  if (airing === undefined)
    return "いま流れている番組が番組表に無いため、復号を確かめられません";
  if (airing.isFree)
    return "いまは無料の番組を流しているため、復号を確かめられません。有料の番組の間にもう一度試してください";
  return null;
}

/**
 * 対象局のストリームを数秒間開いて TS パケットのスクランブルビットを検証し、
 * 復号可否 (decode_ok) を更新する。
 */
export async function testDecode(
  serviceId: number,
  /** どのエージェントのカードで確かめるか (設定のダイアログを開いたエージェント)。渡さなければ並びの先頭 */
  agent?: number,
): Promise<DecodeResult> {
  const card = await decodeCard(agent);
  if (card === null) return { ok: false, decodeOk: false, error: NO_CARD };

  const targetService = orm()
    .select(DECODE_TARGET)
    .from(services)
    .where(eq(services.id, serviceId))
    .get();
  if (!targetService)
    return { ok: false, decodeOk: false, error: "局が見つかりません" };

  const notPaid = notPaidNow(serviceId, Date.now());
  if (notPaid !== null) return { ok: false, decodeOk: false, error: notPaid };

  const results = await decodeOnChannel(card, [targetService]);
  return (
    results.get(serviceId) ?? {
      ok: false,
      decodeOk: false,
      error: "復号を確かめられませんでした",
    }
  );
}

/** まとめて確かめた結果。局ごとの結果か、まとめて確かめられなかった理由 */
type DecodeAll =
  | { ok: true; results: Map<number, DecodeResult> }
  | { ok: false; error: string };

/** `testDecodeUnverified` が動いている間 */
let decodingUnverified = false;

/**
 * **確かめていない有料の局を、物理チャンネルごとに 1 回の選局でまとめて確かめる** (設定のダイアログ)。
 * 対象は `getContractRows` で「確かめていない」(`unverified`) の局のうち、いま有料の番組を流している局。
 * ほかの局は確かめずに、理由を付けて返す。チャンネルは 1 つずつ順に選局する (チューナーを 1 台しか使わない)
 */
export async function testDecodeUnverified(
  /** どのエージェントのカードで確かめるか。渡さなければ並びの先頭 */
  agent?: number,
): Promise<DecodeAll> {
  // 別のタブから重ねて押されたら断る (同じチャンネルを 2 回選局してチューナーを取り合う)
  if (decodingUnverified)
    return { ok: false, error: "ほかの画面でまとめて確かめています" };
  decodingUnverified = true;
  try {
    return await decodeUnverified(agent);
  } finally {
    decodingUnverified = false;
  }
}

async function decodeUnverified(agent?: number): Promise<DecodeAll> {
  const card = await decodeCard(agent);
  if (card === null) return { ok: false, error: NO_CARD };

  const now = Date.now();
  const unverified = new Set(
    getContractRows(card.card, now)
      .filter((row) => row.status === "unverified")
      .map((row) => row.serviceId),
  );
  const results = new Map<number, DecodeResult>();
  if (unverified.size === 0) return { ok: true, results };
  const targets: DecodeTarget[] = [];
  for (const target of orm()
    .select(DECODE_TARGET)
    .from(services)
    .where(inArray(services.id, [...unverified]))
    .all()) {
    const notPaid = notPaidNow(target.id, now);
    if (notPaid === null) targets.push(target);
    else results.set(target.id, { ok: false, decodeOk: false, error: notPaid });
  }
  for (const group of groupByChannel(targets))
    for (const [id, result] of await decodeOnChannel(card, group))
      results.set(id, result);
  return { ok: true, results };
}

/**
 * **1 つの TS を 1 回だけ選局し、その中の局ごとに復号できるかを確かめて card_contracts に書く。**
 * `targets` は同じ TS の局 (`groupByChannel`)。選局は、確かめるカードで復号するエージェント (`decodeCard`) のうち局を受けられる所に振り分ける
 * (カードの無いエージェントや別のカードのエージェントで受けると、そのカードの契約を確かめたことにならない)。
 * 選局に失敗したら、どの局も確かめられなかったことにする
 */
async function decodeOnChannel(
  card: { card: string; agents: ReadonlySet<number> },
  targets: DecodeTarget[],
): Promise<Map<number, DecodeResult>> {
  const results = new Map<number, DecodeResult>();
  const first = targets[0];
  if (first === undefined) return results;
  const places = first.places === null ? [] : strictPlaces(first.places);
  const mine = places.filter((place) => card.agents.has(place.agent));
  if (mine.length === 0) {
    const error = places.length === 0 ? NO_CHANNEL : NO_CARD_PLACE;
    for (const target of targets)
      results.set(target.id, { ok: false, decodeOk: false, error });
    return results;
  }
  /*
   * **局ごとに、その局のパケットだけを数える** (`ServiceFilter`)。物理チャンネルには同じ中継器のほかの局も入っていて、
   * スクランブルの無い局のパケットまで数えると、復号できなくても割合が下がる
   */
  const counts = targets.map((target) => ({
    target,
    filter: new ServiceFilter(target.arib),
    count: new ScrambleCount(DECODE_PACKETS),
  }));
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 15_000);

  try {
    // 取り合いの順をスキャンと同じにしてストリームを開く。利用者の名前を live で始めて、エージェントに鍵を取らせる (`Sink.WantsKeys`)
    const stream = await openChannelStream(
      first.type,
      mine,
      abortController.signal,
      "live test-decode",
      config.priority.scan,
    );

    const reader = stream.getReader();
    while (counts.some(({ count }) => !count.full)) {
      // 15 秒で打ち切ったら、それまでに数えたぶんで判定する
      const next = await reader.read().catch((error: unknown) => {
        if (abortController.signal.aborted)
          return { done: true, value: undefined };
        throw error;
      });
      const { done, value } = next;
      if (done || !value) break;

      for (const { filter, count } of counts) {
        const own = filter.filter(value);
        const media = mediaPids(filter.streams);
        for (let offset = 0; offset + PACKET <= own.length; offset += PACKET)
          count.feed(own.subarray(offset, offset + PACKET), media);
      }
    }

    try {
      await reader.cancel();
    } catch {
      // 無視
    }
  } catch (err) {
    for (const target of targets)
      results.set(target.id, {
        ok: false,
        decodeOk: false,
        error: `選局またはストリーム受信に失敗しました: ${err}`,
      });
    return results;
  } finally {
    clearTimeout(timeout);
    abortController.abort();
  }

  // 書くのは受け終えてから (書けなかったときに、選局の失敗と取り違えない)
  for (const {
    target,
    count: { total, scrambled },
  } of counts) {
    if (total < 50) {
      results.set(target.id, {
        ok: false,
        decodeOk: false,
        error: "ストリームから十分なパケットを受信できませんでした",
      });
      continue;
    }
    // 0.5 未満なら復号成功とみなす (正常な復号 TS はスクランブル比率 0)
    const decodeOk = scrambled / total < 0.5;
    saveDecode(card.card, target.id, decodeOk);
    results.set(target.id, { ok: true, decodeOk });
  }
  return results;
}

/**
 * 復号を確かめた結果を card_contracts に書く (`decodeOnChannel`、`noteDecoded`)。
 *
 * **カードに聞けない行 (`code` が無い) の状態は、復号の結果で決める** (できたら契約中、できなければ未契約)。新しく作る行も
 * 前からある行も同じ。録画が復号し直しても掛かったままだったときに未契約に下げる (`noteStillScrambled`) のと同じ物差し
 */
function saveDecode(
  cardId: string,
  serviceId: number,
  decodeOk: boolean,
  now = Date.now(),
): void {
  const state: ContractState = decodeOk ? "subscribed" : "unsubscribed";
  orm()
    .insert(cardContracts)
    .values({
      card_id: cardId,
      service_id: serviceId,
      state,
      source: "decode",
      code: null,
      valid_until: null,
      decode_ok: decodeOk,
      decoded_at: decodeOk ? now : null,
      checked_at: now,
    })
    .onConflictDoUpdate({
      target: [cardContracts.card_id, cardContracts.service_id],
      set: {
        decode_ok: decodeOk,
        decoded_at: decodeOk ? now : null,
        // **手動設定がある行と、カードが答えた行 (code がある) は状態を変えない。**
        state: sql`CASE WHEN ${cardContracts.manual_state} IS NULL AND ${cardContracts.code} IS NULL THEN ${state} ELSE ${cardContracts.state} END`,
        source: sql`CASE WHEN ${cardContracts.manual_state} IS NULL AND ${cardContracts.code} IS NULL THEN 'decode' ELSE ${cardContracts.source} END`,
        checked_at: now,
      },
    })
    .run();
}

/**
 * **有料の番組を復号できて録れた。** その局を、復号テストで確かめたときと同じく契約中にする (`encoder.ts`。`noteStillScrambled` の反対)。
 * 番組表に契約の情報 (0xCB) が無い局は、手で予約した録画でも契約中になり、録り続けている間は 31 日 (`DECODE_VALID_MS`) を過ぎても契約中のまま。
 *
 * 書くのは、復号したエージェント (後から復号させたエージェント、無ければ録ったエージェントの `recordings.agent_id`) がいま使っているカードの行。録ったエージェントが分からない (列を足す前の録画)・
 * もう無いときは並びの先頭のエージェントのカード。カードが読めないときは書かない (どのカードで観られたか分からない)。
 * カードが答えた行 (`code` がある) の状態は変えない (`saveDecode`)
 */
export async function noteDecoded(
  serviceId: number,
  agentId: number | null = null,
): Promise<void> {
  const agent =
    agentId === null ? undefined : listAgents().find((a) => a.id === agentId);
  const cardId = await usableCardId(agent);
  if (cardId !== null) saveDecode(cardId, serviceId, true);
}

export type ContractWarning = "expired" | "unsubscribed" | null;

/**
 * 局の契約の警告 (予約・番組の詳しく・番組表のバッジ)。無料の番組と、契約中のカードがある局・確かめていない局は null。
 * どのカードにも契約が無ければ、期限切れのカードがあれば "expired"、無ければ "unsubscribed"
 */
export function getContractWarning(
  serviceId: number,
  isFree = false,
): ContractWarning {
  if (isFree) return null;
  const settings = getContractSettings();
  // 契約意志リストが設定されており、対象外となっている有料局は警告を出さない
  if (
    settings.intendedServiceIds !== null &&
    !settings.intendedServiceIds.includes(serviceId)
  ) {
    return null;
  }
  if (paidAllowed()(serviceId)) return null;
  const states = orm()
    .select({ state: cardContracts.state })
    .from(cardContracts)
    .where(eq(cardContracts.service_id, serviceId))
    .all()
    .map((row) => row.state);
  if (states.length === 0 || states.includes("subscribed")) return null;
  return states.includes("expired") ? "expired" : "unsubscribed";
}

export interface ContractNotice {
  providerId: ContractProviderId;
  providerName: string;
  mode: "modal" | "banner";
  channels: {
    serviceId: number;
    name: string;
    validUntil: number;
  }[];
}

/**
 * 1 週間以内に契約期限が切れる局を事業者ごとにまとめた案内情報を取得する。
 * contract_modal_mode が "none" の場合は空配列を返す。
 */
export function getExpiringContractNotices(now = Date.now()): ContractNotice[] {
  const settings = getContractSettings();
  if (settings.modalMode === "none") return [];

  const oneWeekLater = now + 7 * 86_400_000;
  const rows = orm()
    .select({
      serviceId: cardContracts.service_id,
      name: services.name,
      type: services.type,
      validUntil: cardContracts.valid_until,
      state: cardContracts.state,
    })
    .from(cardContracts)
    .innerJoin(services, eq(services.id, cardContracts.service_id))
    .where(
      and(
        sql`${cardContracts.valid_until} IS NOT NULL`,
        gt(cardContracts.valid_until, now),
        lte(cardContracts.valid_until, oneWeekLater),
      ),
    )
    .all();

  // 契約意志リストがある場合、対象外の局は除外
  const intendedSet =
    settings.intendedServiceIds !== null
      ? new Set(settings.intendedServiceIds)
      : null;

  const providerMap = new Map<
    ContractProviderId,
    {
      providerName: string;
      channels: { serviceId: number; name: string; validUntil: number }[];
    }
  >();

  for (const row of rows) {
    if (intendedSet && !intendedSet.has(row.serviceId)) continue;
    if (row.validUntil === null) continue;

    const provider = getContractProvider(row.serviceId, row.type, row.name);
    let entry = providerMap.get(provider.id);
    if (!entry) {
      entry = { providerName: provider.name, channels: [] };
      providerMap.set(provider.id, entry);
    }
    if (!entry.channels.some((c) => c.serviceId === row.serviceId)) {
      entry.channels.push({
        serviceId: row.serviceId,
        name: row.name,
        validUntil: row.validUntil,
      });
    }
  }

  const notices: ContractNotice[] = [];
  for (const [providerId, data] of providerMap.entries()) {
    if (data.channels.length > 0) {
      notices.push({
        providerId,
        providerName: data.providerName,
        mode: settings.modalMode,
        channels: data.channels,
      });
    }
  }
  return notices;
}

/** まとめて復号テストした 1 局ぶんの結果 */
export interface DecodeTestResult {
  serviceId: number;
  ok: boolean;
  decodeOk: boolean;
  error?: string | undefined;
}

/** 一括テストで、1 局あたりに数えるパケット数の上限 (個別テストと同じ) */
const BATCH_TARGET_PACKETS = 2000;

/** 一括テストで、1 つの物理チャンネルを開いておく上限 (個別テストと同じ) */
const BATCH_TIMEOUT_MS = 15_000;

/** 一括テストの対象 (同じ物理チャンネルの局を 1 回の選局でまとめて数える) */
interface DecodeCandidate {
  serviceId: number;
  arib: number;
  places: string;
  type: string;
}

/**
 * カードが答えていない局をまとめて復号テストする。
 *
 * **同じ物理チャンネルの局は 1 回の選局で済ませる。** 1 局ずつ `testDecode` を呼ぶと、
 * 同じ中継器の局の数だけ選局と待ち時間が増えてしまうため。
 * 対象は `code` が無い行 (番組表に 0xCB が無い局など) のうち、まだ新しく復号を確かめていない局だけ。
 * いま無料の番組を流している局は、スクランブルが掛からず契約と取り違えるので対象外。
 */
export async function testDecodeUnconfirmed(): Promise<{
  cardId: string;
  results: DecodeTestResult[];
}> {
  const card = await cardStatus();
  const cardId = getActiveCardId(card);
  if (!card.ok || !cardId) {
    throw new Error(
      card.message || "B-CAS カードが認識されていないため契約を確認できません",
    );
  }

  const nowMs = Date.now();
  const rows = orm()
    .select({
      serviceId: services.id,
      arib: services.service_id,
      places: servicePlaces(),
      type: services.type,
      decodeOk: cardContracts.decode_ok,
      decodedAt: cardContracts.decoded_at,
    })
    .from(cardContracts)
    .innerJoin(services, eq(services.id, cardContracts.service_id))
    .where(and(eq(cardContracts.card_id, cardId), isNull(cardContracts.code)))
    .orderBy(asc(services.type), asc(services.service_id))
    .all();

  /*
   * いま有料の番組を流している局だけを対象にする。無料の時間帯はスクランブルが掛かっていないので、
   * 復号できたように見えて契約中と取り違える (個別テストと同じ理由)
   */
  const airing = new Map<number, boolean>();
  for (const program of orm()
    .select({ serviceId: programs.service_id, isFree: programs.is_free })
    .from(programs)
    .where(and(lte(programs.start_at, nowMs), gt(programs.end_at, nowMs)))
    .all()) {
    airing.set(
      program.serviceId,
      (airing.get(program.serviceId) ?? false) || !program.isFree,
    );
  }

  const results: DecodeTestResult[] = [];
  const candidates: DecodeCandidate[] = [];
  for (const row of rows) {
    // 31 日のあいだに復号できている局は、確かめ直さない
    if (row.decodeOk === true && freshDecode(row.decodedAt, nowMs)) continue;
    if (airing.get(row.serviceId) !== true) {
      results.push({
        serviceId: row.serviceId,
        ok: false,
        decodeOk: false,
        error: "いま有料の番組を流していないため、復号を確かめられません",
      });
      continue;
    }
    if (!row.places || strictPlaces(row.places).length === 0) {
      results.push({
        serviceId: row.serviceId,
        ok: false,
        decodeOk: false,
        error: NO_CHANNEL,
      });
      continue;
    }
    candidates.push({ ...row, places: row.places });
  }

  const groups = new Map<string, DecodeCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.type}\u0000${candidate.places}`;
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }

  for (const group of groups.values()) {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), BATCH_TIMEOUT_MS);
    const filters = group.map((candidate) => ({
      candidate,
      filter: new ServiceFilter(candidate.arib),
      total: 0,
      scrambled: 0,
    }));

    try {
      const stream = await openChannelStream(
        group[0]!.type,
        strictPlaces(group[0]!.places),
        abortController.signal,
        "live test-decode",
        5,
      );
      const reader = stream.getReader();
      try {
        while (filters.some((f) => f.total < BATCH_TARGET_PACKETS)) {
          const next = await reader.read().catch((error: unknown) => {
            if (abortController.signal.aborted)
              return { done: true, value: undefined };
            throw error;
          });
          const { done, value } = next;
          if (done || !value) break;

          for (const f of filters) {
            const own = f.filter.filter(value);
            for (
              let offset = 0;
              offset + PACKET <= own.length;
              offset += PACKET
            ) {
              if (own[offset] !== SYNC) continue;
              // ペイロードの無いパケットはスクランブルの対象にならない
              if ((own[offset + 3]! & 0x10) === 0) continue;
              f.total++;
              // 4 バイト目の上位 2 ビットが transport_scrambling_control
              if ((own[offset + 3]! & 0xc0) !== 0) f.scrambled++;
            }
          }
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          // 無視
        }
      }

      for (const f of filters) {
        if (f.total < 50) {
          results.push({
            serviceId: f.candidate.serviceId,
            ok: false,
            decodeOk: false,
            error: "ストリームから十分なパケットを受信できませんでした",
          });
          continue;
        }
        const decodeOk = f.scrambled / f.total < 0.5;
        saveDecode(cardId, f.candidate.serviceId, decodeOk);
        results.push({
          serviceId: f.candidate.serviceId,
          ok: true,
          decodeOk,
        });
      }
    } catch (err) {
      for (const f of filters) {
        results.push({
          serviceId: f.candidate.serviceId,
          ok: false,
          decodeOk: false,
          error: `選局またはストリーム受信に失敗しました: ${err}`,
        });
      }
    } finally {
      clearTimeout(timeout);
      abortController.abort();
    }
  }

  return { cardId, results };
}

/**
 * **有料放送を自動予約してよい局** (`rules.PaidAllowed`)。どれかのカードで契約中と確かめた局だけ。
 *
 * 未契約・期限切れの局と、まだ確かめていない局 (確かめる前・カードが無い・番組表に 0xCB が無く
 * 復号も試していない) は録らない。録ってもスクランブルのままで観られないため。
 * カードを持たない人は、無料の番組だけを録る。
 * カードに聞けない局 (番組表に 0xCB が無い) は、復号テストか有料の番組を復号できた録画から 31 日のあいだだけ (`DECODE_VALID_MS`)。
 * 手動設定で契約中 (`manualState === 'subscribed'`) にされた局も契約中として許可する。
 * 1 回の当てはめで 1 回だけ読む (呼ぶ側が関数を使い回す)
 */
export function paidAllowed(now = Date.now()): (serviceId: number) => boolean {
  const contractSettings = getContractSettings();
  const rows = orm()
    .select({
      serviceId: cardContracts.service_id,
      manualState: cardContracts.manual_state,
      state: cardContracts.state,
      code: cardContracts.code,
      decodedAt: cardContracts.decoded_at,
      serviceType: services.type,
      serviceName: services.name,
    })
    .from(cardContracts)
    .leftJoin(services, eq(services.id, cardContracts.service_id))
    .where(eq(cardContracts.state, "subscribed"))
    .all();

  const subscribed = new Set<number>();
  let wowowSubscribed = false;
  let skyperfectSubscribed = false;

  for (const row of rows) {
    if (row.manualState === "unsubscribed") continue;
    const isDirectlyAllowed =
      row.manualState === "subscribed" ||
      row.code !== null ||
      freshDecode(row.decodedAt, now);

    if (isDirectlyAllowed) {
      subscribed.add(row.serviceId);
      const provider = getContractProvider(
        row.serviceId,
        row.serviceType ?? undefined,
        row.serviceName ?? undefined,
      );
      if (provider.id === "wowow") {
        wowowSubscribed = true;
      }
      if (
        provider.id === "skyperfect" &&
        (getAribServiceId(row.serviceId) === 800 ||
          Boolean(row.serviceName?.includes("スカチャン"))) &&
        (row.code !== null || freshDecode(row.decodedAt, now))
      ) {
        skyperfectSubscribed = true;
      }
    }
  }

  // WOWOW 連動 または スカパー！一括同期
  if (wowowSubscribed || skyperfectSubscribed) {
    const candidateServices = orm()
      .select({
        id: services.id,
        type: services.type,
        name: services.name,
      })
      .from(services)
      .where(inArray(services.type, ["BS", "CS"]))
      .all();

    const excludedServices = new Set(
      orm()
        .select({ serviceId: cardContracts.service_id })
        .from(cardContracts)
        .where(
          or(
            eq(cardContracts.manual_state, "unsubscribed"),
            eq(cardContracts.state, "expired"),
            eq(cardContracts.state, "unsubscribed"),
          ),
        )
        .all()
        .map((r) => r.serviceId),
    );

    if (wowowSubscribed) {
      for (const s of candidateServices) {
        if (excludedServices.has(s.id)) continue;
        if (getContractProvider(s.id, s.type, s.name).id === "wowow") {
          subscribed.add(s.id);
        }
      }
    }

    if (skyperfectSubscribed) {
      for (const s of candidateServices) {
        if (excludedServices.has(s.id)) continue;
        if (getContractProvider(s.id, s.type, s.name).id === "skyperfect") {
          subscribed.add(s.id);
        }
      }
    }
  }

  // 契約意志リスト (intendedServiceIds) が明示されている場合、
  // 契約意志のない局は録画許可の対象外にする
  if (contractSettings.intendedServiceIds !== null) {
    const intendedSet = new Set(contractSettings.intendedServiceIds);
    for (const sid of Array.from(subscribed)) {
      if (!intendedSet.has(sid)) {
        subscribed.delete(sid);
      }
    }
  }

  return (serviceId) => subscribed.has(serviceId);
}

/**
 * **手で予約した有料の番組が、スクランブルのまま録れるかもしれないときの通知の文** (番組表・検索の「予約」)。
 * 予約は断らない (手で録ると決めたのは人なので)。録ってよい局 (`paidAllowed`) でなければ、理由を付けた文を返す。
 * 無料の番組と、番組表に無い番組は null
 */
export function reserveWarning(
  programId: number,
  now = Date.now(),
): string | null {
  const program = orm()
    .select({ serviceId: programs.service_id, isFree: programs.is_free })
    .from(programs)
    .where(eq(programs.id, programId))
    .get();
  if (program === undefined || program.isFree) return null;
  if (paidAllowed(now)(program.serviceId)) return null;
  // カードが複数あれば、期限切れ → 未契約 → 確かめていない の順に強いほうを出す
  const statuses = serviceContracts(program.serviceId, null, now);
  const tail = "録画がスクランブルのまま残ることがあります";
  if (statuses.has("expired"))
    return `予約しました。この局は契約の期限が切れているため、${tail}`;
  if (statuses.has("unsubscribed"))
    return `予約しました。この局は未契約のため、${tail}`;
  // 行が無い、カードに聞けず復号の結果も無いか古い
  return `予約しました。この局の契約を確かめていないため、${tail}。設定の「受信」にある「有料契約を確認」で確かめられます`;
}

/** 局の契約の状態 (カードごと)。決め方はダイアログと同じ (`contractStatus`)。`card` を渡せばそのカードの行だけ。行が無ければ空 */
function serviceContracts(
  serviceId: number,
  card: string | null = null,
  now = Date.now(),
): Set<ContractStatus> {
  return new Set(
    orm()
      .select({
        state: cardContracts.state,
        code: cardContracts.code,
        decodeOk: cardContracts.decode_ok,
        decodedAt: cardContracts.decoded_at,
      })
      .from(cardContracts)
      .where(
        and(
          eq(cardContracts.service_id, serviceId),
          card === null ? undefined : eq(cardContracts.card_id, card),
        ),
      )
      .all()
      .map((row) => contractStatus(row, now)),
  );
}

/**
 * **ライブで局の映像・音声がスクランブルされたまま届いたときの文** (`live.ts`)。
 *
 * エージェントは、カードが鍵を返さなかった (未契約の) ES をスクランブルされたまま流す。カードを読めないときも同じ形で届くので、
 * 先にカードの状態で分ける。読めているなら、残る理由は契約。期限切れと分かっている局はそう書き、契約中と確かめた局は
 * カードが鍵を返さなかったことだけを書く。それ以外 (未契約・確かめていない・行が無い) は契約されていないと書く。
 * B-CAS 以外の方式の局は、選局する前に断っている (`services.decodable`)
 *
 * @param cardReadable エージェントがカードを読めているか (`CardStatus.ok`)
 * @param statuses その局の契約の状態 (`serviceContracts`)
 */
export function scrambledLiveMessage(
  cardReadable: boolean,
  statuses: ReadonlySet<ContractStatus>,
): string {
  const tail = "スクランブルを復号できませんでした";
  if (!cardReadable) return `B-CAS カードを読めないため、${tail}`;
  if (statuses.has("expired"))
    return `この局は契約の期限が切れているため、${tail}`;
  if (statuses.size > 0 && [...statuses].every((s) => s === "subscribed"))
    return `カードが鍵を返さないため、${tail}`;
  return `この局は契約されていないため、${tail}`;
}

/**
 * `scrambledLiveMessage` を、いまのカードと契約の状態で。`agent` はライブの選局を送ったエージェント (`agents.id`) で、
 * そのエージェントが復号に使うカードと、そのカードの契約で決める。分からなければ並びの先頭のエージェントと、全部のカードの契約
 */
export async function scrambledLiveNotice(
  serviceId: number,
  agent: number | null = null,
): Promise<string> {
  const target =
    agent === null ? undefined : listAgents().find((a) => a.id === agent);
  const card = await cardStatus(target);
  const id = target === undefined ? null : getActiveCardId(card);
  return scrambledLiveMessage(card.ok, serviceContracts(serviceId, id));
}

/**
 * **有料の番組の録画が、復号し直しても掛かったまま終わった。** 復号テストで契約中としていた局を未契約に下げる
 * (`encoder.ts`)。契約が切れたあとも 31 日待たずに、次の回から録らなくなる。
 *
 * 下げるのは、カードに聞けない局 (`code` が無い行) かつ手動設定されていない行だけ。カードが契約中と答えた局は、掛かったままの理由が
 * ほかにある (ECM が流れていない など) ので、カードの答えを信じる (次の定期の確認で確かめ直す)。
 * 下げるのは復号に使ったカード (`cardId`) の行だけ。ほかのカードで契約を確かめた局まで録らなくならないように。
 * カードが分からなければ全部のカードの行
 */
export function noteStillScrambled(
  serviceId: number,
  cardId: string | null = null,
): void {
  orm()
    .update(cardContracts)
    .set({
      state: "unsubscribed",
      source: "decode",
      decode_ok: false,
      decoded_at: null,
      checked_at: Date.now(),
    })
    .where(
      and(
        eq(cardContracts.service_id, serviceId),
        cardId === null ? undefined : eq(cardContracts.card_id, cardId),
        eq(cardContracts.state, "subscribed"),
        isNull(cardContracts.code),
        isNull(cardContracts.manual_state),
      ),
    )
    .run();
}

/**
 * 対象局の契約状態を手動設定 (manual override) または解除する。
 *
 * manualState に null を指定すると手動設定が解除され、自動判定 (カード確認または復号テスト) の結果に戻る。
 */
export async function setManualContract(
  serviceId: number,
  manualState: "subscribed" | "unsubscribed" | "unknown" | null,
): Promise<{
  ok: boolean;
  row?: ContractRow | undefined;
  error?: string | undefined;
}> {
  const card = await cardStatus();
  const cardId = getActiveCardId(card);
  if (!card.ok || !cardId) {
    return {
      ok: false,
      error: "B-CAS カードが認識されていません",
    };
  }

  const targetService = orm()
    .select({ id: services.id })
    .from(services)
    .where(eq(services.id, serviceId))
    .get();

  if (!targetService) {
    return {
      ok: false,
      error: `局が見つかりません (serviceId: ${serviceId})`,
    };
  }

  const existing = orm()
    .select({
      code: cardContracts.code,
      validUntil: cardContracts.valid_until,
      decodeOk: cardContracts.decode_ok,
      decodedAt: cardContracts.decoded_at,
    })
    .from(cardContracts)
    .where(
      and(
        eq(cardContracts.card_id, cardId),
        eq(cardContracts.service_id, serviceId),
      ),
    )
    .get();

  const countRes = orm()
    .select({ count: sql<number>`count(*)` })
    .from(programs)
    .where(
      and(
        eq(programs.service_id, serviceId),
        eq(programs.is_free, false),
        sql`${programs.contract_verification} IS NOT NULL`,
      ),
    )
    .get();
  const hasEitCa = (countRes?.count ?? 0) > 0;

  const now = Date.now();
  const evaluated = ContractChecker.evaluate(
    {
      manualState,
      code: existing?.code,
      validUntil: existing?.validUntil,
      decodeOk: existing?.decodeOk,
      decodedAt: existing?.decodedAt,
      hasEitCa,
    },
    now,
  );

  orm()
    .insert(cardContracts)
    .values({
      card_id: cardId,
      service_id: serviceId,
      state: evaluated.state,
      source: evaluated.source,
      manual_state: manualState,
      code: existing?.code ?? null,
      valid_until: existing?.validUntil ?? null,
      decode_ok: existing?.decodeOk ?? null,
      decoded_at: existing?.decodedAt ?? null,
      checked_at: now,
    })
    .onConflictDoUpdate({
      target: [cardContracts.card_id, cardContracts.service_id],
      set: {
        state: evaluated.state,
        source: evaluated.source,
        manual_state: manualState,
        checked_at: now,
      },
    })
    .run();

  const rows = getContractRows(cardId);
  const row = rows.find((r) => r.serviceId === serviceId);
  return { ok: true, row };
}
