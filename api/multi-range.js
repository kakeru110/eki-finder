// Vercel serverless function. Keeps EKISPERT_API_KEY server-side and proxies
// requests to 駅すぱあとAPI's multipleRange (範囲探索) endpoint.
//
// GET /api/multi-range?stations=新宿,横浜,町田&minutes=90
//   stations: 2〜8件、カンマ区切りの駅名(職場 or 自宅の最寄駅)
//   minutes:  各駅からの上限所要時間(分, 10〜200)。省略時90分
//
// レスポンス: { stations, upperMinute, candidates: [{ code, name, prefecture, minutesByPerson: [...], transfersByPerson: [...] }] }
// candidates は stations 全員が upperMinute 以内に到達できる駅のみを含む。
//
// 駅すぱあとのレスポンスはXMLをJSON化したものなので、要素が1件のときは配列でなく
// オブジェクトになる(既知の挙動)。toArray() で必ず配列に正規化して扱う。
//
// 同名駅が複数県にまたがって存在する場合(例: 「田町」は東京都のJR駅の他に高知県にも
// 存在する)、修飾なしの駅名だと E102「駅名が見つかりません」で失敗することがある。
// この場合サーバー側で「駅名(都道府県)」の形に付け替えて自動リトライする。

const KANTO_PREFS = ["東京都", "神奈川県", "埼玉県", "千葉県"];
const MAX_RETRIES_PER_BATCH = 8;

// 駅すぱあとAPI(買い切り型)は合計5,000リクエストで打ち止め、自動更新はされない。
// Vercel KV(Upstash Redis)にリクエスト件数を記録し、閾値到達時にFormSubmit経由で
// 運営者にメール通知する。KV未設定の場合は何もせず通常通り動作する(検索自体は止めない)。
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const USAGE_COUNT_KEY = "ekispert_request_count";
const USAGE_THRESHOLDS = [4500, 4900, 5000];
const NOTIFY_EMAIL = "kakeru.senoo@gmail.com";

async function trackEkispertUsage() {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    const authHeader = { Authorization: `Bearer ${KV_TOKEN}` };
    const incrRes = await fetch(`${KV_URL}/incr/${USAGE_COUNT_KEY}`, { headers: authHeader });
    const { result: count } = await incrRes.json();

    for (const threshold of USAGE_THRESHOLDS) {
      if (count < threshold) continue;
      // setnxで「この閾値は通知済みか」を記録し、閾値ごとに一度だけ通知する
      const setRes = await fetch(`${KV_URL}/setnx/notified_${threshold}/1`, { headers: authHeader });
      const { result: wasFirstTime } = await setRes.json();
      if (wasFirstTime === 1) {
        await notifyUsageThreshold(threshold, count);
      }
    }
  } catch (err) {
    console.error("usage tracking failed", err);
  }
}

async function notifyUsageThreshold(threshold, count) {
  const reachedLimit = count >= 5000;
  const message = reachedLimit
    ? `駅すぱあとAPI(買い切り型、上限5,000件)の使用件数が${count}件に到達し、上限を使い切りました。以降は実データAPIが使えず、概算値へのフォールバックのみになります。追加購入等の対応が必要です。`
    : `駅すぱあとAPI(買い切り型、上限5,000件)の使用件数が${count}件に到達しました。上限まで残りわずかです。`;
  const body = new URLSearchParams({
    _subject: `【集合駅ナビ】駅すぱあとAPI使用件数が${threshold}件に到達`,
    message,
  });
  try {
    await fetch(`https://formsubmit.co/ajax/${NOTIFY_EMAIL}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
  } catch (err) {
    console.error("usage notification failed", err);
  }
}

// 駅すぱあとAPIの「平均待ち時間ベース」の計算は、本数の少ない支線だと実際の所要時間より
// 過大に出る(例: 海芝浦↔鶴見は実際は直通12分程度だがAPIは42分前後を返す)。時刻表データを
// 持たない買い切り型プランでは区間ごとの正確な補正はできないため、実測値がわかっている駅に
// ついてのみ、出発/到着どちらかに含まれる場合に一律で分数を差し引く簡易補正を行う。
const BRANCH_LINE_CORRECTION_MINUTES = { "海芝浦": 30 };

function applyBranchLineCorrection(names, candidates) {
  const originCorrections = names.map((n) => BRANCH_LINE_CORRECTION_MINUTES[n] || 0);
  for (const c of candidates.values()) {
    const destCorrection = BRANCH_LINE_CORRECTION_MINUTES[c.name] || 0;
    c.minutesByPerson = c.minutesByPerson.map((m, i) => {
      if (m === null) return m;
      const correction = Math.max(originCorrections[i], destCorrection);
      return correction ? Math.max(0, m - correction) : m;
    });
  }
}

// 平均待ち時間探索は「出発時の待ち時間」は最初の1本にも乗せて計算する一方、乗換時に
// 実際に生じる乗換先の平均待ち時間はごくわずか(本数の多い幹線に乗り換える場合など)しか
// 乗らないことがある。実際の乗換には歩行・ホーム移動等で数分かかるのが通例のため、
// 乗換回数(TransferCount)1回につき固定でTRANSFER_WAIT_MINUTESを加算する補正を行う。
const TRANSFER_WAIT_MINUTES = 3;

function applyTransferWaitBuffer(candidates) {
  for (const c of candidates.values()) {
    c.minutesByPerson = c.minutesByPerson.map((m, i) => {
      if (m === null) return m;
      const transfers = c.transfersByPerson[i];
      if (!transfers) return m;
      return m + transfers * TRANSFER_WAIT_MINUTES;
    });
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "GET only" });
    return;
  }

  const apiKey = process.env.EKISPERT_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "EKISPERT_API_KEY is not configured on the server" });
    return;
  }

  const stationsParam = req.query.stations;
  if (!stationsParam) {
    res.status(400).json({ error: "stations is required" });
    return;
  }
  const names = String(stationsParam)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length < 2 || names.length > 8) {
    res.status(400).json({ error: "stations must contain 2 to 8 names" });
    return;
  }
  const upperMinute = Math.min(200, Math.max(10, Number(req.query.minutes) || 90));

  const batches = [];
  for (let i = 0; i < names.length; i += 5) batches.push(names.slice(i, i + 5));

  // code -> { code, name, prefecture, minutesByPerson: [人数分, 未到達はnull] }
  const candidates = new Map();
  let globalOffset = 0;

  for (const batch of batches) {
    let resultSet;
    try {
      resultSet = await callWithDisambiguation(apiKey, batch, upperMinute);
    } catch (err) {
      res.status(502).json({ error: err.message || String(err) });
      return;
    }

    for (const point of toArray(resultSet.Point)) {
      const station = point.Station || {};
      const code = station.code;
      if (!code) continue;
      if (!candidates.has(code)) {
        candidates.set(code, {
          code,
          name: station.Name || "",
          prefecture: (point.Prefecture && point.Prefecture.Name) || "",
          minutesByPerson: new Array(names.length).fill(null),
          transfersByPerson: new Array(names.length).fill(null),
        });
      }
      const entry = candidates.get(code);
      for (const cost of toArray(point.Cost)) {
        const localIdx = Number(cost.baseIndex) - 1; // baseIndexは1始まり
        if (Number.isNaN(localIdx)) continue;
        const globalIdx = globalOffset + localIdx;
        if (globalIdx >= 0 && globalIdx < names.length) {
          entry.minutesByPerson[globalIdx] = Number(cost.Minute);
          entry.transfersByPerson[globalIdx] = Number(cost.TransferCount);
        }
      }
    }
    globalOffset += batch.length;
  }

  applyBranchLineCorrection(names, candidates);
  applyTransferWaitBuffer(candidates);

  // 全員が到達できる駅だけを候補として返す
  const full = [...candidates.values()].filter((c) => c.minutesByPerson.every((m) => m !== null));

  res.status(200).json({ stations: names, upperMinute, candidates: full });
};

// baseNamesのいずれかがE102(駅名が見つかりません)で失敗したら、その駅名に
// 都道府県修飾子を順番に付けてリトライする。成功したらResultSetを返す。
async function callWithDisambiguation(apiKey, baseNames, upperMinute) {
  const names = [...baseNames];
  for (let attempt = 0; attempt < MAX_RETRIES_PER_BATCH; attempt++) {
    const data = await callMultiRange(apiKey, names, upperMinute);
    const err = data && data.ResultSet && data.ResultSet.Error;
    if (!err) return data.ResultSet;

    if (err.code === "E102") {
      const match = /\(([^)]+)\)\s*$/.exec(err.Message || "");
      const failingName = match ? match[1] : null;
      const idx = failingName ? names.indexOf(failingName) : -1;
      if (idx === -1) {
        throw new Error(`ekispert API error ${err.code}: ${err.Message}`);
      }
      const currentQualifier = /\(([^)]+)\)$/.exec(failingName);
      const baseName = currentQualifier ? failingName.slice(0, currentQualifier.index) : failingName;
      const nextPrefIndex = currentQualifier ? KANTO_PREFS.indexOf(currentQualifier[1]) + 1 : 0;
      if (nextPrefIndex >= KANTO_PREFS.length) {
        throw new Error(`駅名を解決できませんでした: ${baseName}`);
      }
      names[idx] = `${baseName}(${KANTO_PREFS[nextPrefIndex]})`;
      continue;
    }
    throw new Error(`ekispert API error ${err.code}: ${err.Message}`);
  }
  throw new Error("駅名解決の再試行回数が上限に達しました");
}

async function callMultiRange(apiKey, baseNames, upperMinute) {
  const baseList = baseNames.map((n) => encodeURIComponent(n)).join(":");
  const upperMinuteList = baseNames.map(() => upperMinute).join(":");
  const url =
    `https://api.ekispert.jp/v1/json/search/multipleRange` +
    `?key=${encodeURIComponent(apiKey)}&baseList=${baseList}&upperMinute=${upperMinuteList}` +
    `&plane=false&shinkansen=false`;

  let r;
  try {
    r = await fetch(url);
  } catch (err) {
    throw new Error(`ekispert APIに接続できませんでした: ${err}`);
  }
  await trackEkispertUsage(); // 実際にAPIへ届いた時点でカウント(成功/エラー応答に関わらず1件消費とみなす)
  const data = await r.json().catch(() => null);
  if (!data || !data.ResultSet) {
    throw new Error(`ekispert APIの応答が不正です(HTTP ${r.status})`);
  }
  return data;
}

function toArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}
