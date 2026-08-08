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
